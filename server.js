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
const SESSION_DAYS = 180;
const DEVICE_DAYS = 730;
const DEVICE_COOKIE = "sct_d";
const COOKIE = "sct_s";

let KEY = process.env.ANTHROPIC_API_KEY || "";
let TTS_KEY = process.env.OPENAI_API_KEY || "";
const TTS_KEY_FILE = () => path.join(DATA_DIR, "ttskey");
const TTS_VOICE = { m: process.env.TTS_VOICE_M || "cedar", f: process.env.TTS_VOICE_F || "marin", c: process.env.TTS_VOICE_C || "ash" };
const KEY_FROM_ENV = !!KEY;
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
let PROVIDER = "none";
let MODELS = { default: process.env.ANTHROPIC_MODEL || "", complex: process.env.ANTHROPIC_MODEL || "", quick: process.env.ANTHROPIC_MODEL || "" };

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
function mintDevice() {
  const v = crypto.randomBytes(9).toString("base64url") + "." + String(Date.now() + DEVICE_DAYS * 864e5);
  return v + "." + sign(v);
}
function knownDevice(req) {
  const tok = cookies(req)[DEVICE_COOKIE];
  if (!tok) return false;
  const i = tok.lastIndexOf(".");
  if (i < 1) return false;
  const body = tok.slice(0, i), sig = tok.slice(i + 1), expect = sign(body);
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  return Number(body.split(".")[1]) > Date.now();
}

/* ---------------- rate limiting ---------------- */
const buckets = new Map();
/* The passcode is short, so the lockout does the work. Failures from devices that
   have never logged in are counted globally; past a threshold every unknown device is
   refused outright, and each repeat lockout lasts longer. A device that has logged in
   before carries a signed token and is never locked out, so the owner cannot be
   denied his own app by someone else's brute force. */
const LOCK_STEPS = [15 * 60000, 60 * 60000, 6 * 3600000, 24 * 3600000];
const FAILS_BEFORE_LOCK = 15;
let gFails = 0, gWindow = 0, gLockUntil = 0, gLockStep = -1;
function noteFail() {
  const now = Date.now();
  if (now > gWindow) { gFails = 0; gWindow = now + 15 * 60000; }
  gFails++;
  if (gFails >= FAILS_BEFORE_LOCK) {
    gLockStep = Math.min(gLockStep + 1, LOCK_STEPS.length - 1);
    gLockUntil = now + LOCK_STEPS[gLockStep];
    gFails = 0; gWindow = now + 15 * 60000;
    console.warn("[auth] global lockout for unknown devices, %d minutes", LOCK_STEPS[gLockStep] / 60000);
  }
}
function lockedOut() { return Date.now() < gLockUntil; }
function clearLock() { gFails = 0; gLockUntil = 0; gLockStep = -1; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      MODELS = { default: fast, complex: newest(/opus/i) || fast, quick: newest(/haiku/i) || fast };
      console.log("[provider] anthropic  default=%s complex=%s", MODELS.default, MODELS.complex);
    } catch (e) {
      console.error("[provider] model detection failed:", redact(e.message));
      MODELS = { default: "claude-sonnet-4-5", complex: "claude-sonnet-4-5", quick: "claude-haiku-4-5" };
    }
    return;
  }
  try {
    const tags = await ollama("/api/tags", "GET", null);
    const names = (tags.models || []).map((m) => m.name);
    if (!names.length) throw new Error("no local models");
    const pick = names.find((n) => /llama3|qwen|mistral/i.test(n)) || names[0];
    PROVIDER = "ollama"; MODELS = { default: pick, complex: pick, quick: pick };
    console.log("[provider] ollama model=%s", pick);
  } catch (e) { PROVIDER = "none"; console.log("[provider] none"); }
}
function openai(pathname, method, body, raw) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.openai.com", path: pathname, method,
      headers: Object.assign({ authorization: "Bearer " + TTS_KEY },
        payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {})
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(raw ? buf : JSON.parse(buf.toString() || "{}"));
        let msg = "HTTP " + res.statusCode;
        try { msg = JSON.parse(buf.toString()).error.message; } catch (e) {}
        reject(Object.assign(new Error(redact(msg)), { status: res.statusCode }));
      });
    });
    req.on("error", (e) => reject(new Error(redact(e.message))));
    req.setTimeout(45000, () => req.destroy(new Error("tts timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}
function loadSavedKey() {
  try {
    if (!TTS_KEY) {
      const k = fs.readFileSync(TTS_KEY_FILE(), "utf8").trim();
      if (/^sk-/.test(k)) { TTS_KEY = k; console.log("[tts] restored a saved key"); }
    }
  } catch (e) {}
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

app.post("/api/login", async (req, res) => {
  const ip = ipOf(req);
  if (!PASSCODE) return res.status(503).json({ ok: false, message: "APP_PASSCODE is not configured on the server." });
  const known = knownDevice(req);
  if (!known && lockedOut()) {
    const mins = Math.ceil((gLockUntil - Date.now()) / 60000);
    return res.status(429).json({ ok: false, message: "Locked for " + mins + " more minutes. Try again then." });
  }
  /* A device that has logged in before gets a far looser per-IP allowance, so a
     fat-fingered PIN on a shared cellular IP never locks the owner out. */
  const l = limit("login:" + (known ? "k:" : "") + ip, known ? 60 : 10, 15 * 60000);
  if (!l.ok) return res.status(429).json({ ok: false, message: "Too many attempts. Wait " + l.retryAfter + "s." });
  /* Known-device is a convenience, not a bypass: nobody fat-fingers a PIN 120 times a day. */
  if (known) {
    const kd = limit("logind:" + String(cookies(req)[DEVICE_COOKIE] || "").slice(0, 32), 120, 24 * 3600000);
    if (!kd.ok) return res.status(429).json({ ok: false, message: "Too many attempts on this device today." });
  }
  await sleep(300 + Math.floor(Math.random() * 200));
  let given = String((req.body && req.body.passcode) || "").trim();
  /* A saved password, a stray space or a keyboard's smart punctuation should not cost
     him a login. When the PIN is all digits, judge only the digits he entered. */
  if (/^\d+$/.test(PASSCODE)) given = given.replace(/\D/g, "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(PASSCODE).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    if (!known) noteFail();
    console.warn("[auth] failed login from %s (ip %d, global %d, known %s)", ip, l.n, gFails, known);
    return res.status(401).json({ ok: false, message: "Wrong PIN." });
  }
  buckets.delete("login:" + ip);
  clearLock();
  res.setHeader("Set-Cookie", [
    COOKIE + "=" + mint() + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_DAYS * 86400,
    DEVICE_COOKIE + "=" + mintDevice() + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + DEVICE_DAYS * 86400
  ]);
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

app.get("/api/export.ok", (req, res) => res.json({ ok: true }));
app.get("/api/health", (req, res) => {
  const withKey = !!reqKey(req);
  res.json({ ok: true, ai: PROVIDER !== "none" || withKey, server_ai: PROVIDER !== "none", provider: withKey && PROVIDER !== "anthropic" ? "anthropic-user" : PROVIDER, model: MODELS.default || null, tts: !!TTS_KEY });
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
      MODELS = { default: fast, complex: newest(/opus/i) || fast, quick: newest(/haiku/i) || fast };
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

app.post("/api/ttskey", async (req, res) => {
  const key = String((req.body && req.body.key) || "").trim();
  if (!/^sk-[A-Za-z0-9_\-]{10,200}$/.test(key)) return res.json({ ok: false, message: "That does not look like an OpenAI key." });
  const l = limit("ttskey:" + ipOf(req), 12, 60 * 60000);
  if (!l.ok) return res.status(429).json({ ok: false, message: "Too many key attempts." });
  const prev = TTS_KEY;
  TTS_KEY = key;
  try {
    await openai("/v1/audio/speech", "POST", { model: "gpt-4o-mini-tts", voice: TTS_VOICE.m, input: "Testing.", response_format: "mp3" }, true);
    try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(TTS_KEY_FILE(), key, { mode: 0o600 }); } catch (e) {}
    res.json({ ok: true });
  } catch (e) {
    TTS_KEY = prev;
    res.json({ ok: false, message: e.status === 401 ? "That key was rejected by OpenAI." : "Could not verify the key." });
  }
});

app.post("/api/tts", async (req, res) => {
  if (!TTS_KEY) return res.status(503).json({ error: "no_tts" });
  const l = limit("tts:" + ipOf(req), 400, 10 * 60000);
  if (!l.ok) return res.status(429).json({ error: "rate_limited" });
  const text = String((req.body && req.body.text) || "").slice(0, 600);
  if (!text.trim()) return res.status(400).json({ error: "bad_input" });
  const coach = (req.body && req.body.role) === "coach";
  const voice = coach ? TTS_VOICE.c : ((req.body && req.body.woman) ? TTS_VOICE.f : TTS_VOICE.m);
  const instructions = String((req.body && req.body.instructions) || "").slice(0, 1200);
  try {
    const buf = await openai("/v1/audio/speech", "POST",
      { model: "gpt-4o-mini-tts", voice, input: text, instructions, response_format: "mp3" }, true);
    /* ~13 characters a second of speech at $0.015 a minute. The client meters this;
       speech was previously invisible in his spend and it is the largest single line. */
    res.setHeader("x-cost-est", String((text.length / 13 / 60) * 0.015));
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buf.length);
    res.end(buf);
  } catch (e) {
    console.error("[tts]", e.status || "", redact(e.message));
    res.status(502).json({ error: "upstream" });
  }
});

app.post("/api/chat", async (req, res) => {
  const ip = ipOf(req);
  const burst = limit("chat:" + ip, 60, 10 * 60000);
  if (!burst.ok) return res.status(429).json({ error: "rate_limited", message: "Slow down for " + burst.retryAfter + "s." });
  const daily = limit("chatd:" + ip, 600, 24 * 3600000);
  if (!daily.ok) return res.status(429).json({ error: "rate_limited", message: "Daily call limit reached." });
  /* One user, one phone. A global ceiling caps the damage a leaked session can do. */
  const globalDay = limit("chatd:all", 900, 24 * 3600000);
  if (!globalDay.ok) return res.status(429).json({ error: "rate_limited", message: "Daily limit reached for this app." });

  const userKey = reqKey(req);
  if (PROVIDER === "none" && !userKey) return res.status(503).json({ error: "no_provider", message: "No API key yet. Add one with the Key button." });

  const input = req.body && req.body.input;
  const tierIn = (req.body && req.body.tier) || "default";
  const tier = (tierIn === "complex" || tierIn === "quick") ? tierIn : "default";
  const cachePrefix = !!(req.body && req.body.cachePrefix);
  /* No temperature: it is deprecated on the current Sonnet and 502s the call.
     A scoring pass needs far more room than a prospect line, so the cap is per-call. */
  const mtRaw = req.body && req.body.maxTokens;
  const maxTok = (typeof mtRaw === "number" && mtRaw > 0)
    ? Math.min(4000, Math.round(mtRaw))
    : (tier === "complex" ? 2000 : (tier === "quick" ? 400 : 900));
  let messages = typeof input === "string" ? [{ role: "user", content: input }]
    : Array.isArray(input) ? input.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") : null;
  if (!messages || !messages.length) return res.status(400).json({ error: "bad_input" });
  if (messages.length > 40) return res.status(400).json({ error: "too_many_turns" });
  const bytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0);
  if (bytes > 60000) return res.status(413).json({ error: "too_large" });

  try {
    let text, model, usage = null;
    if (userKey || PROVIDER === "anthropic") {
      /* Cache the long static brief: it is message 0 and is byte-identical all run,
         so turns 2..n read it at a tenth of the input price. */
      let msgs = messages;
      if (cachePrefix && messages[0] && typeof messages[0].content === "string" && messages[0].content.length > 4000) {
        msgs = messages.slice();
        msgs[0] = { role: msgs[0].role, content: [{ type: "text", text: msgs[0].content, cache_control: { type: "ephemeral" } }] };
      }
      /* Current Sonnet thinks by default. On the scoring prompt it spent the entire
         token budget reasoning and returned no text at all, which read as a scoring
         failure and quietly fell back to the heuristic. We want the answer, not the
         reasoning — and we do not want to pay output rates for it. */
      const body = {
        model: MODELS[tier] || MODELS.default || "claude-sonnet-4-5",
        max_tokens: maxTok, messages: msgs, thinking: { type: "disabled" }
      };
      let out;
      try { out = await anthropic("/v1/messages", "POST", body, userKey); }
      catch (e) {
        if (e.status === 400 && /thinking/i.test(String(e.message || ""))) {
          delete body.thinking;
          out = await anthropic("/v1/messages", "POST", body, userKey);
        } else throw e;
      }
      text = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      model = out.model;
      usage = out.usage || null;
      if (!text) {
        console.error("[chat] empty text, stop=%s out=%s", out.stop_reason, (out.usage || {}).output_tokens);
        return res.status(502).json({ error: "empty_output", stop: out.stop_reason || null });
      }
    } else {
      const out = await ollama("/api/chat", "POST", {
        model: MODELS[tier] || MODELS.default, messages, stream: false, format: "json",
        options: { temperature: 0.85, num_predict: tier === "complex" ? 1600 : 500 }
      });
      text = (out.message && out.message.content) || ""; model = out.model;
    }
    res.json({ text, model, usage });
  } catch (e) {
    console.error("[chat]", e.status || "", redact(e.message));
    res.status(e.status === 429 ? 429 : 502).json({ error: "upstream", message: redact(e.message) });
  }
});

/* Append-only. A whole-file rewrite on every save meant one crash mid-write
   left invalid JSON and the next save replaced six weeks with a single run. */
const RUNS_LOG = path.join(DATA_DIR, "runs.jsonl");
function readRuns(limit) {
  let rows = [];
  try {
    const txt = fs.readFileSync(RUNS_LOG, "utf8");
    const seen = new Map();
    txt.split("\n").forEach((line) => {
      if (!line.trim()) return;
      try { const r = JSON.parse(line); if (r && r.id) seen.set(r.id, r); } catch (e) {}
    });
    rows = [...seen.values()];
  } catch (e) {
    try { rows = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8")) || []; } catch (e2) { rows = []; }
    if (rows.length) { try {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(RUNS_LOG, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
      console.log("[runs] migrated %d runs to the append log", rows.length);
    } catch (e3) {} }
  }
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return limit ? rows.slice(0, limit) : rows;
}
function appendRun(run) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(RUNS_LOG, JSON.stringify(run) + "\n", { mode: 0o600 });
    return true;
  } catch (e) { console.error("[runs]", redact(e.message)); return false; }
}
app.get("/api/runs", (req, res) => {
  const n = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 600));
  res.json({ runs: readRuns(n) });
});
app.get("/api/export", (req, res) => {
  const rows = readRuns();
  res.setHeader("content-disposition", 'attachment; filename="sct-runs-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json({ exported: new Date().toISOString(), count: rows.length, runs: rows });
});
app.post("/api/runs", (req, res) => {
  const run = req.body && req.body.run;
  if (!run || typeof run.id !== "string" || run.id.length > 64) return res.status(400).json({ error: "bad_run" });
  if (Buffer.byteLength(JSON.stringify(run)) > 200000) return res.status(413).json({ error: "too_large" });
  res.json({ ok: appendRun(run) });
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
input{width:100%;padding:14px;font-size:26px;letter-spacing:.34em;text-align:center;border:1px solid #C6C3BA;border-radius:10px;background:#fff;color:#17191C;font-family:ui-monospace,monospace}
input[hidden]{display:none}
button{width:100%;margin-top:12px;padding:12px;font-size:15px;font-weight:600;border:0;border-radius:8px;background:#8C2F3B;color:#fff}
.e{color:#BE4038;font-size:13.5px;margin-top:10px;min-height:18px}</style></head><body>
<form id="f" autocomplete="off"><h1>Second Conversation Trainer</h1><p>Enter your six-digit PIN.</p>
<label for="p">PIN</label>
<input id="p" name="sct-pin" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6"
 autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" required>
<button type="submit">Unlock</button><div class="e" id="e"></div></form>
<script>var f=document.getElementById("f"),p=document.getElementById("p"),e=document.getElementById("e"),busy=false;
async function go(){if(busy)return;busy=true;e.textContent="Checking…";
try{var r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},
body:JSON.stringify({passcode:p.value})});var j=await r.json();
if(j.ok){location.reload();return}e.textContent=j.message||"Wrong PIN.";p.value="";p.focus()}
catch(x){e.textContent="Could not reach the server."}busy=false}
f.addEventListener("submit",function(ev){ev.preventDefault();go()});
p.addEventListener("input",function(){p.value=p.value.replace(/\D/g,"").slice(0,6);if(p.value.length===6)go()});
p.focus();</script></body></html>`;

loadSavedKey();
detectProvider().finally(() => {
  if (!PASSCODE) console.warn("[auth] APP_PASSCODE is not set — the app is UNPROTECTED.");
  app.listen(PORT, "0.0.0.0", () => console.log("SCT on :%s provider=%s auth=%s", PORT, PROVIDER, PASSCODE ? "on" : "OFF"));
});
