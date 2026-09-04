"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const RUNS_FILE = path.join(DATA_DIR, "runs.json");
const KEY_FILE = path.join(DATA_DIR, "key");

const PASSCODE = (process.env.APP_PASSCODE || "").trim();
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_DAYS = 30;
const COOKIE = "sct_s";

let KEY = process.env.ANTHROPIC_API_KEY || "";
const KEY_FROM_ENV = !!KEY;
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
let PROVIDER = "none";
let MODELS = { default: process.env.ANTHROPIC_MODEL || "", complex: process.env.ANTHROPIC_MODEL || "" };

const redact = (s) => String(s == null ? "" : s).replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-***REDACTED***");

/* ---------------- sessions ---------------- */
function sign(v) { return crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("base64url"); }
function mint() {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return exp + "." + sign(exp);
}
function valid(tok) {
  if (!tok || typeof tok !== "string") return false;
  const i = tok.lastIndexOf(".");
  if (i < 1) return false;
  const exp = tok.slice(0, i), sig = tok.slice(i + 1);
  const expect = sign(exp);
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  return Number(exp) > Date.now();
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function authed(req) { return !PASSCODE || valid(cookies(req)[COOKIE]); }

/* ---------------- rate limiting ---------------- */
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 60000).unref();
function limit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return { ok: b.n <= max, retryAfter: Math.ceil((b.reset - now) / 1000), n: b.n };
}
function ipOf(req) { return (req.ip || req.socket.remoteAddress || "?").replace(/^::ffff:/, ""); }

/* ---------------- upstream ---------------- */
function anthropic(pathname, method, body, keyOverride) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.anthropic.com", path: pathname, method,
      headers: Object.assign(
        { "x-api-key": keyOverride || KEY, "anthropic-version": "2023-06-01" },
        payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}
      )
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => {
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else reject(Object.assign(new Error(redact((j && j.error && j.error.message) || ("HTTP " + res.statusCode))), { status: res.statusCode }));
      });
    });
    req.on("error", (e) => reject(new Error(redact(e.message))));
    req.setTimeout(90000, () => req.destroy(new Error("upstream timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}
async function ollama(pathname, method, body) {
  const res = await fetch(OLLAMA_URL + pathname, {
    method, headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw Object.assign(new Error("ollama HTTP " + res.status), { status: res.status });
  return res.json();
}
async function detectProvider() {
  if (KEY) {
    PROVIDER = "anthropic";
    if (process.env.ANTHROPIC_MODEL) return;
    try {
      const list = await anthropic("/v1/models?limit=100", "GET", null);
      const ids = (list.data || []).map((m) => m.id);
      const newest = (re) => ids.filter((id) => re.test(id)).sort().reverse()[0];
      const fast = newest(/sonnet/i) || newest(/haiku/i) || ids[0];
      MODELS = { default: fast, complex: newest(/opus/i) || fast };
      console.log("[provider] anthropic  default=%s complex=%s", MODELS.default, MODELS.complex);
    } catch (e) {
      console.error("[provider] model detection failed:", redact(e.message));
      MODELS = { default: "claude-sonnet-4-5", complex: "claude-sonnet-4-5" };
    }
    return;
  }
  try {
    const tags = await ollama("/api/tags", "GET", null);
    const names = (tags.models || []).map((m) => m.name);
    if (!names.length) throw new Error("no local models");
    const pick = names.find((n) => /llama3|qwen|mistral/i.test(n)) || names[0];
    PROVIDER = "ollama"; MODELS = { default: pick, complex: pick };
    console.log("[provider] ollama model=%s", pick);
  } catch (e) { PROVIDER = "none"; console.log("[provider] none"); }
}
function loadSavedKey() {
  if (KEY) return;
  try {
    const k = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (/^sk-/.test(k)) { KEY = k; console.log("[key] restored a saved key"); }
  } catch (e) {}
}

/* ---------------- app ---------------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; media-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=(), interest-cohort=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  next();
});

/* unauthenticated liveness only — leaks nothing */
app.get("/api/ping", (req, res) => res.json({ ok: true }));

app.post("/api/login", (req, res) => {
  const ip = ipOf(req);
  const l = limit("login:" + ip, 10, 15 * 60000);
  if (!l.ok) return res.status(429).json({ ok: false, message: "Too many attempts. Wait " + l.retryAfter + "s." });
  if (!PASSCODE) return res.status(503).json({ ok: false, message: "APP_PASSCODE is not configured on the server." });
  const given = String((req.body && req.body.passcode) || "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(PASSCODE).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    console.warn("[auth] failed login from %s (%d)", ip, l.n);
    return res.status(401).json({ ok: false, message: "Wrong passcode." });
  }
  res.setHeader("Set-Cookie", COOKIE + "=" + mint() + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_DAYS * 86400);
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

/* everything below requires a session */
app.use((req, res, next) => {
  if (authed(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
  return res.status(401).type("html").send(LOGIN_PAGE);
});

app.get("/api/health", (req, res) => {
  const withKey = !!reqKey(req);
  res.json({ ok: true, ai: PROVIDER !== "none" || withKey, provider: withKey && PROVIDER !== "anthropic" ? "anthropic-user" : PROVIDER, model: MODELS.default || null });
});
function reqKey(req) {
  const h = req.get("x-user-key");
  return (h && /^sk-[A-Za-z0-9_\-]{10,200}$/.test(h.trim())) ? h.trim() : "";
}

app.post("/api/key", async (req, res) => {
  if (KEY_FROM_ENV) return res.json({ ok: false, message: "The key is set as a server environment variable and cannot be changed here." });
  const key = String((req.body && req.body.key) || "").trim();
  if (!/^sk-[A-Za-z0-9_\-]{10,200}$/.test(key)) return res.json({ ok: false, message: "That does not look like an Anthropic key." });
  const l = limit("key:" + ipOf(req), 12, 60 * 60000);
  if (!l.ok) return res.status(429).json({ ok: false, message: "Too many key attempts." });
  try {
    const list = await anthropic("/v1/models?limit=100", "GET", null, key);
    const ids = (list.data || []).map((m) => m.id);
    const newest = (re) => ids.filter((id) => re.test(id)).sort().reverse()[0];
    const fast = newest(/sonnet/i) || newest(/haiku/i) || ids[0];
    if (req.body && req.body.persist) {
      KEY = key; PROVIDER = "anthropic";
      MODELS = { default: fast, complex: newest(/opus/i) || fast };
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
      } catch (e) { console.error("[key] persist failed:", redact(e.message)); }
    }
    res.json({ ok: true, model: fast });
  } catch (e) {
    res.json({ ok: false, message: e.status === 401 ? "That key was rejected by Anthropic." : "Could not verify the key." });
  }
});
app.delete("/api/key", (req, res) => {
  if (KEY_FROM_ENV) return res.json({ ok: false, message: "Key is set by environment variable." });
  KEY = ""; PROVIDER = "none";
  try { fs.unlinkSync(KEY_FILE); } catch (e) {}
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  const ip = ipOf(req);
  const burst = limit("chat:" + ip, 60, 10 * 60000);
  if (!burst.ok) return res.status(429).json({ error: "rate_limited", message: "Slow down for " + burst.retryAfter + "s." });
  const daily = limit("chatd:" + ip, 600, 24 * 3600000);
  if (!daily.ok) return res.status(429).json({ error: "rate_limited", message: "Daily call limit reached." });

  const userKey = reqKey(req);
  if (PROVIDER === "none" && !userKey) return res.status(503).json({ error: "no_provider", message: "No API key yet. Add one with the Key button." });

  const input = req.body && req.body.input;
  const tier = (req.body && req.body.tier) === "complex" ? "complex" : "default";
  let messages = typeof input === "string" ? [{ role: "user", content: input }]
    : Array.isArray(input) ? input.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") : null;
  if (!messages || !messages.length) return res.status(400).json({ error: "bad_input" });
  if (messages.length > 60) return res.status(400).json({ error: "too_many_turns" });
  const bytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0);
  if (bytes > 200000) return res.status(413).json({ error: "too_large" });

  try {
    let text, model;
    if (userKey || PROVIDER === "anthropic") {
      const out = await anthropic("/v1/messages", "POST", {
        model: MODELS[tier] || MODELS.default || "claude-sonnet-4-5",
        max_tokens: tier === "complex" ? 2000 : 700, messages
      }, userKey);
      text = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      model = out.model;
    } else {
      const out = await ollama("/api/chat", "POST", {
        model: MODELS[tier] || MODELS.default, messages, stream: false, format: "json",
        options: { temperature: 0.85, num_predict: tier === "complex" ? 1600 : 500 }
      });
      text = (out.message && out.message.content) || ""; model = out.model;
    }
    res.json({ text, model });
  } catch (e) {
    console.error("[chat]", e.status || "", redact(e.message));
    res.status(e.status === 429 ? 429 : 502).json({ error: "upstream", message: redact(e.message) });
  }
});

function readRuns() { try { return JSON.parse(fs.readFileSync(RUNS_FILE, "utf8")); } catch (e) { return []; } }
function writeRuns(rows) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(RUNS_FILE, JSON.stringify(rows.slice(0, 500)), { mode: 0o600 });
    return true;
  } catch (e) { console.error("[runs]", redact(e.message)); return false; }
}
app.get("/api/runs", (req, res) => res.json({ runs: readRuns() }));
app.post("/api/runs", (req, res) => {
  const run = req.body && req.body.run;
  if (!run || typeof run.id !== "string" || run.id.length > 64) return res.status(400).json({ error: "bad_run" });
  if (Buffer.byteLength(JSON.stringify(run)) > 200000) return res.status(413).json({ error: "too_large" });
  const rows = readRuns().filter((r) => r.id !== run.id);
  rows.unshift(run);
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  res.json({ ok: writeRuns(rows), count: rows.length });
});

app.use(express.static(path.join(__dirname, "public"), { maxAge: 0, etag: true, dotfiles: "ignore" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Second Conversation Trainer</title>
<style>:root{color-scheme:light dark}*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#F4F3F0;color:#17191C;
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
@media(prefers-color-scheme:dark){body{background:#121316;color:#E9EAEC}form{background:#1A1C20!important;border-color:#2B2F35!important}input{background:#121316!important;color:#E9EAEC!important;border-color:#3C424A!important}}
form{background:#fff;border:1px solid #DDDBD4;border-radius:12px;padding:26px;width:100%;max-width:360px;
box-shadow:0 8px 24px -12px rgba(0,0,0,.2)}
h1{font:600 19px/1.2 Georgia,serif;margin:0 0 6px}p{margin:0 0 18px;color:#7C8088;font-size:14px}
label{display:block;font:500 11px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#7C8088;margin-bottom:7px}
input{width:100%;padding:11px;font-size:16px;border:1px solid #C6C3BA;border-radius:8px;background:#fff;color:#17191C}
button{width:100%;margin-top:12px;padding:12px;font-size:15px;font-weight:600;border:0;border-radius:8px;background:#8C2F3B;color:#fff}
.e{color:#BE4038;font-size:13.5px;margin-top:10px;min-height:18px}</style></head><body>
<form id="f"><h1>Second Conversation Trainer</h1><p>This trainer is private. Enter your passcode.</p>
<label for="p">Passcode</label>
<input id="p" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" required>
<button type="submit">Unlock</button><div class="e" id="e"></div></form>
<script>document.getElementById("f").addEventListener("submit",async function(ev){ev.preventDefault();
var e=document.getElementById("e");e.textContent="Checking…";
try{var r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},
body:JSON.stringify({passcode:document.getElementById("p").value})});var j=await r.json();
if(j.ok){location.reload()}else{e.textContent=j.message||"Wrong passcode."}}
catch(x){e.textContent="Could not reach the server."}});</script></body></html>`;

loadSavedKey();
detectProvider().finally(() => {
  if (!PASSCODE) console.warn("[auth] APP_PASSCODE is not set — the app is UNPROTECTED.");
  app.listen(PORT, "0.0.0.0", () => console.log("SCT on :%s provider=%s auth=%s", PORT, PROVIDER, PASSCODE ? "on" : "OFF"));
});
