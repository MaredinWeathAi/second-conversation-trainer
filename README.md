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

## Method

Trains a nine-step sequence: recognize the trigger, ask what made it come up now,
scope it business/personal/both, name the real category, ask who is helping them
think through it, expose the gap without criticizing the incumbent, use a micro-story,
decline to solve in the social setting, bridge to a second conversation.

Scored 1-10 across ten categories out of 100: Premature Advice Control, Trigger
Recognition, Emotional Driver Discovery, Question Progression, Incumbent Setup
Discovery, Wedge Creation, Story/Analogy Use, Frame Control, Brevity, Second
Conversation Bridge. A competent untrained advisor lands 45-55.

The prospect's interest is recomputed client-side from the model's own delta codes
rather than trusted, and the acceptance gate is enforced locally: interest above the
difficulty threshold, steps 2/5/6 satisfied, not currently solving, and a clean bridge.

A parallel coach call runs per exchange on the quick tier. It never blocks the
prospect's reply. Harmful moves are spoken aloud; everything else is visual only.

## Analytics

Day / week / month / year. Score trend per category, floor vs ceiling, binding
constraint, discovery vs delivery, scripts-vs-skill gap, hollow win rate, and the
share of runs where the prospect named the real issue themselves. Periods below the
minimum sample size never render an average - they show the raw values and say how
many more reps are needed.

## Casting

Every run casts a prospect: sex drawn from a per-scenario probability weighted to who
actually holds the role (0.07 for an orthopedic surgeon, 0.50 for a family office heir,
0.45 for a staffing-firm owner), a Miami-appropriate first name drawn from an origin
bucket (Cuban-American, Colombian, Venezuelan, Anglo South Florida, Northeastern
transplant) weighted by age and archetype, and an accent template that drives both the
prospect prompt and the voice. Women aged 66+ in retired-executive scenarios draw a
widow variant 40% of the time. Nothing is locked to one sex.

## Voice

`speechSynthesis` on iOS Safari can only reach Apple's pre-installed compact voices -
Samantha, Aaron, Nicky. Enhanced, Premium and Siri voices are withheld from web pages
by design, so no amount of tuning makes the iPhone sound natural. Chrome on macOS does
expose downloaded Enhanced/Premium voices.

So: hosted TTS is primary when `OPENAI_API_KEY` is set (`gpt-4o-mini-tts`, whose
`instructions` field carries the accent and the distracted-at-a-party delivery),
served through `POST /api/tts` and played sentence by sentence through one AudioContext.
The built-in engine is the automatic fallback, with platform-aware ordered voice
preferences, a novelty-voice exclusion list, per-sex pitch, and jittered rate.
Spanish-locale voices reading English are deliberately never used - they apply Spanish
letter-to-sound rules to English words and read as a struggling non-native speaker.

## Drive mode

Hands-free continuous practice for a phone. Runs scenario -> roleplay -> spoken
scorecard -> next scenario without any tapping. Holds a screen wake lock, speaks
sentence by sentence (iOS truncates long utterances), and restarts recognition
after every utterance because iOS Safari ends the session each time.

On iPhone: open in Safari, tap Drive mode, allow the microphone once.

Browser history in `localStorage` is the source of truth, so the app keeps working
if the server store is wiped by a redeploy.
