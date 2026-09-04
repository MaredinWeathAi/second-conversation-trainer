"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");

const PORT = process.env.PORT || 3000;
const KEY = process.env.ANTHROPIC_API_KEY || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const RUNS_FILE = path.join(DATA_DIR, "runs.json");

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
let PROVIDER = "none";           // "anthropic" | "ollama" | "none"
let MODELS = { default: process.env.ANTHROPIC_MODEL || "", complex: process.env.ANTHROPIC_MODEL || "" };

/* ---------- Anthropic REST helper ---------- */
function anthropic(pathname, method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.anthropic.com",
      path: pathname,
      method: method,
      headers: Object.assign({
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01"
      }, payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {})
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(d); } catch (e) { /* non-JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else reject(Object.assign(new Error((j && j.error && j.error.message) || ("HTTP " + res.statusCode)), { status: res.statusCode, body: j }));
      });
    });
    req.on("error", reject);
    req.setTimeout(90000, () => { req.destroy(new Error("upstream timeout")); });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------- Ollama helper (local models, no key needed) ---------- */
async function ollama(pathname, method, body) {
  const res = await fetch(OLLAMA_URL + pathname, {
    method: method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw Object.assign(new Error("ollama HTTP " + res.status), { status: res.status });
  return res.json();
}

/* Pick the provider and real model IDs rather than hardcoding a guess. */
async function detectProvider() {
  if (KEY) {
    PROVIDER = "anthropic";
    if (process.env.ANTHROPIC_MODEL) {
      console.log("[provider] anthropic, pinned model:", process.env.ANTHROPIC_MODEL);
      return;
    }
    try {
      const list = await anthropic("/v1/models?limit=100", "GET", null);
      const ids = (list.data || []).map((m) => m.id);
      const newest = (re) => ids.filter((id) => re.test(id)).sort().reverse()[0];
      const fast = newest(/sonnet/i) || newest(/haiku/i) || ids[0];
      MODELS = { default: fast, complex: newest(/opus/i) || fast };
      console.log("[provider] anthropic  default=%s complex=%s", MODELS.default, MODELS.complex);
    } catch (e) {
      console.error("[provider] anthropic model detection failed:", e.message);
      MODELS = { default: "claude-sonnet-4-5", complex: "claude-sonnet-4-5" };
    }
    return;
  }
  try {
    const tags = await ollama("/api/tags", "GET", null);
    const names = (tags.models || []).map((m) => m.name);
    if (!names.length) throw new Error("no local models");
    const pick = names.find((n) => /llama3|qwen|mistral/i.test(n)) || names[0];
    PROVIDER = "ollama";
    MODELS = { default: pick, complex: pick };
    console.log("[provider] ollama at %s  model=%s", OLLAMA_URL, pick);
  } catch (e) {
    PROVIDER = "none";
    console.log("[provider] none — set ANTHROPIC_API_KEY (or run Ollama) for the live prospect.");
  }
}

/* ---------- app ---------- */
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "5m", etag: true }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ai: PROVIDER !== "none", provider: PROVIDER, model: MODELS.default || null, ts: Date.now() });
});

app.post("/api/chat", async (req, res) => {
  if (PROVIDER === "none") return res.status(503).json({ error: "no_provider", message: "No ANTHROPIC_API_KEY and no reachable Ollama." });
  const input = req.body && req.body.input;
  const tier = (req.body && req.body.tier) === "complex" ? "complex" : "default";
  const messages = typeof input === "string"
    ? [{ role: "user", content: input }]
    : Array.isArray(input) ? input.filter((m) => m && m.role && m.content) : null;
  if (!messages || !messages.length) return res.status(400).json({ error: "bad_input" });
  try {
    let text, model;
    if (PROVIDER === "anthropic") {
      const out = await anthropic("/v1/messages", "POST", {
        model: MODELS[tier] || MODELS.default,
        max_tokens: tier === "complex" ? 2000 : 700,
        messages: messages
      });
      text = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      model = out.model;
    } else {
      const out = await ollama("/api/chat", "POST", {
        model: MODELS[tier] || MODELS.default,
        messages: messages,
        stream: false,
        format: "json",
        options: { temperature: 0.85, num_predict: tier === "complex" ? 1600 : 500 }
      });
      text = (out.message && out.message.content) || "";
      model = out.model;
    }
    res.json({ text: text, model: model });
  } catch (e) {
    console.error("[chat]", e.status || "", e.message);
    res.status(e.status === 429 ? 429 : 502).json({ error: "upstream", message: e.message });
  }
});

/* ---------- best-effort run store ---------- */
function readRuns() {
  try { return JSON.parse(fs.readFileSync(RUNS_FILE, "utf8")); } catch (e) { return []; }
}
function writeRuns(rows) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RUNS_FILE, JSON.stringify(rows.slice(0, 500)));
    return true;
  } catch (e) { console.error("[runs] write failed:", e.message); return false; }
}
app.get("/api/runs", (req, res) => res.json({ runs: readRuns() }));
app.post("/api/runs", (req, res) => {
  const run = req.body && req.body.run;
  if (!run || !run.id) return res.status(400).json({ error: "bad_run" });
  const rows = readRuns().filter((r) => r.id !== run.id);
  rows.unshift(run);
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  res.json({ ok: writeRuns(rows), count: rows.length });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

detectProvider().finally(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("Second Conversation Trainer on :%s  (provider=%s)", PORT, PROVIDER);
  });
});
