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
| `ANTHROPIC_API_KEY` | optional | You can instead paste a key into the app (Key button). Without either, the app runs a built-in scripted prospect. |
| `ANTHROPIC_MODEL` | no | Overrides auto-detection. |
| `PORT` | no | Railway sets this. |
| `DATA_DIR` | no | Where run history JSON is kept. Defaults to `./data`. |

## Endpoints

- `GET  /api/health` — `{ ok, ai, model }`. `ai:false` means no key is configured.
- `POST /api/chat` — `{ input, tier }` -> `{ text }`. Server-side proxy to the Anthropic Messages API.
- `POST /api/key` — verify a key pasted in the app; `{persist:true}` keeps it server-side for other devices.
- `DELETE /api/key` — forget the saved key.
- `GET  /api/runs` / `POST /api/runs` — run history (best-effort file store; the browser also keeps its own copy).

## Drive mode

Hands-free continuous practice for a phone. Runs scenario -> roleplay -> spoken
scorecard -> next scenario without any tapping. Holds a screen wake lock, speaks
sentence by sentence (iOS truncates long utterances), and restarts recognition
after every utterance because iOS Safari ends the session each time.

On iPhone: open in Safari, tap Drive mode, allow the microphone once.

Browser history in `localStorage` is the source of truth, so the app keeps working
if the server store is wiped by a redeploy.
