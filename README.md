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

## Drive mode

Hands-free continuous practice for a phone. Runs scenario -> roleplay -> spoken
scorecard -> next scenario without any tapping. Holds a screen wake lock, speaks
sentence by sentence (iOS truncates long utterances), and restarts recognition
after every utterance because iOS Safari ends the session each time.

On iPhone: open in Safari, tap Drive mode, allow the microphone once.

Browser history in `localStorage` is the source of truth, so the app keeps working
if the server store is wiped by a redeploy.
