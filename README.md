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
| `APP_PASSCODE` | **yes** | Without it the server logs a warning and runs unprotected. |
| `SESSION_SECRET` | strongly advised | Without it sessions reset on every deploy. |
| `OPENAI_API_KEY` | no | Enables the natural voice. Can also be pasted in Settings. |
| `PORT` | no | Railway sets this. |
| `DATA_DIR` | no | Where run history JSON is kept. Defaults to `./data`. |

## Security

The whole app is behind a passcode. Nothing — not the page, not an asset, not an
API route — is served without a valid session, except `GET /api/ping`.

- `APP_PASSCODE` gates everything, compared in constant time. It is a short PIN, so
  the lockout carries the weight rather than the length: 15 failures from devices
  that have never logged in trigger a hard global lockout, escalating 15 min -> 1 h
  -> 6 h -> 24 h on repeats. That caps an attacker at about 1,440 guesses a day.
- A device that has logged in before carries a separate signed token (2 years) and is
  exempt from that lockout, so a stranger's brute force can never lock the owner out
  of his own app. It also gets a looser per-IP allowance (60 vs 10 per 15 min).
- Every login attempt costs a 300-500 ms server-side delay regardless of outcome.
- Session is an HMAC-signed cookie (`HttpOnly; Secure; SameSite=Lax`, 180 days)
  keyed on `SESSION_SECRET`. Set that variable so sessions survive a redeploy.
- Rate limits per IP: 60 model calls / 10 min, 600 / day, 12 key attempts / hour.
- Request caps: 256 KB body, 60 turns, 200 KB of prompt text.
- Headers: CSP (`connect-src 'self'` blocks exfiltration of a stored key),
  HSTS, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy: microphone=(self)`.
  `x-powered-by` removed.
- API keys are redacted from every log line and error returned to the browser.
- The key file and run store are written `0600` inside a `0700` directory.
- When `ANTHROPIC_API_KEY` is set as an env var, the in-app key field is disabled
  so a session cannot overwrite it.

## Endpoints

- `GET  /api/health` — `{ ok, ai, model }`. `ai:false` means no key is configured.
- `POST /api/chat` — `{ input, tier }` -> `{ text }`. Server-side proxy to the Anthropic Messages API.
- `GET  /api/ping` — unauthenticated liveness. Leaks nothing.
- `POST /api/login` / `POST /api/logout` — session.
- `POST /api/key` — verify a key pasted in the app; `{persist:true}` keeps it server-side for other devices.
- `DELETE /api/key` — forget the saved key.
- `GET  /api/runs` / `POST /api/runs` — run history (best-effort file store; the browser also keeps its own copy).

## Method — 2Q + Bridge

The trainer drills one reflex in the 60-120 second window between a social remark
and an agreed coffee. It is not a planning simulator.

Six states, each with a pass condition:

1. **Positioning** — say what you do, briefly, aimed at owners and complex families.
2. **Why now** — "What made that come up now?"
3. **Bucket** — narrow to a category, or business vs personal.
4. **Pattern insight** — one line of recognition. No solution, no product.
5. **Coffee bridge** — move it out of the room, low pressure, with a timeframe.
6. **Contact capture** — the number, the calendar, or a named day.

States are tracked as goals achieved, not a fixed sequence, so answering out of order
still counts; timing is scored separately.

**Bridge timing is scored explicitly.** The prospect emits a resonance cue ("that's
exactly what I haven't figured out"). Bridging within one turn of it scores 9-10.
Bridging before goals 2 and 3 are met caps the phase at 4. Missing the cue caps it at 5.

Scored 1-10 across the six phases, 60 total, plus one of three results: **success**
(coffee accepted and a next step pinned), **partial** (coffee, vague close), **missed**.

The prospect punishes in character rather than breaking role: a named product makes
them cooler and shorter, over 45 words makes them distracted, an early bridge gets
deflected. After accepting coffee they will never volunteer their number — silence
until you ask, then two vague turns and they leave.

## Drive mode

Hands-free continuous practice for a phone. Runs scenario -> roleplay -> spoken
scorecard -> next scenario without any tapping. Holds a screen wake lock, speaks
sentence by sentence (iOS truncates long utterances), and restarts recognition
after every utterance because iOS Safari ends the session each time.

On iPhone: open in Safari, tap Drive mode, allow the microphone once.

Browser history in `localStorage` is the source of truth, so the app keeps working
if the server store is wiped by a redeploy.
