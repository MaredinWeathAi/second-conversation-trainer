#!/bin/bash
# Second Conversation Trainer — local launcher
# Runs the trainer against your local Ollama model, so the prospect and the
# scoring are fully AI-driven with no API key and no usage cost.

cd "$(dirname "$0")/sct-trainer" || { echo "sct-trainer folder not found next to this launcher."; read -r; exit 1; }

PORT=4123
export PORT

# Make sure Ollama is up — it's what plays the prospect.
if ! curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Starting Ollama…"
  open -ga Ollama 2>/dev/null || (command -v ollama >/dev/null && ollama serve >/dev/null 2>&1 &)
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
fi

[ -d node_modules ] || npm install --no-audit --no-fund

# Free the port if a previous session is still holding it.
lsof -ti tcp:$PORT | xargs kill -9 2>/dev/null

echo "Second Conversation Trainer  →  http://localhost:$PORT"
node server.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM

sleep 2
open -a "Google Chrome" "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT"

echo
echo "Trainer is running. Close this window to stop it."
wait $SERVER_PID
