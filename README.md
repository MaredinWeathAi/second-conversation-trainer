# Second Conversation Trainer

Voice-driven roleplay trainer for high-net-worth advisors. Trains the transition from
casual social conversation to a qualified second meeting — not a sales script.

## Run locally

    npm install
    ANTHROPIC_API_KEY=sk-ant-... npm start
    # http://localhost:3000

## Environment

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes, for the live prospect | Without it the app runs a built-in scripted prospect and heuristic scoring. |
| `ANTHROPIC_MODEL` | no | Overrides auto-detection. |
| `PORT` | no | Railway sets this. |
| `DATA_DIR` | no | Where run history JSON is kept. Defaults to `./data`. |

## Endpoints

- `GET  /api/health` — `{ ok, ai, model }`. `ai:false` means no key is configured.
- `POST /api/chat` — `{ input, tier }` -> `{ text }`. Server-side proxy to the Anthropic Messages API.
- `GET  /api/runs` / `POST /api/runs` — run history (best-effort file store; the browser also keeps its own copy).

Browser history in `localStorage` is the source of truth, so the app keeps working
if the server store is wiped by a redeploy.
