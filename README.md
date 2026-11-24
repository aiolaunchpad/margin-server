# Margin API (backend)

Holds your OpenAI key so **every extension install works with zero setup** — no key, no token, no sign-up.
Zero npm dependencies (Node ≥ 22.13: built-in `node:http` + `node:sqlite`).

## What it does
| Route | Purpose |
|---|---|
| `GET  /v1/health` | `{ ok, version, model, aiConfigured }` (never shows the key) |
| `POST /v1/register` `{ installId }` | Extension calls this automatically on first run → HMAC-signed anonymous token |
| `GET  /v1/me` | `{ plan, usage:{used,limit,resetsAt}, upgradeUrl }` |
| `POST /v1/complete` | The extension's solve / follow-up / Double-Check / quiz / flashcards calls → `{ text, usage }` |
| `POST /v1/admin/plan` | Manually set `free`/`pro` for an install (only if `ADMIN_TOKEN` is set) |
| `POST /v1/stripe/webhook` | Stripe → Pro on `checkout.session.completed`, back to Free when the subscription ends (only if `STRIPE_WEBHOOK_SECRET` is set; never charges anyone) |

- **Free = 5 solves/day per install** (resets at 00:00 UTC). Every AI call (solve, follow-up, Double-Check, quiz, flashcards) counts; failed calls are refunded. At the limit → `429 {code:"quota", upgradeUrl}` and the extension shows the Upgrade card. **OpenAI is not called** once the limit is hit.
- **Pro = unlimited** (optional fair-use cap `PRO_DAILY_LIMIT`).
- **Server-side prompts** — the client's `system` text is ignored, so the endpoint can't be abused as a free general chatbot.
- Model `gpt-4o-mini` (vision) by default; optional `ESCALATION_MODEL` (e.g. `gpt-4o`) for Double-Check/Explain, Pro-only by default.
- Rate limits (per install + per IP), 8 MB body cap, strict input validation, CORS limited to `chrome-extension://` origins (pin your store ID with `ALLOWED_EXTENSION_IDS`).
- Storage: SQLite file in `DATA_DIR` behind a small adapter (`src/store.js`) — swap in Postgres/Redis by implementing the same 7 methods.

## Run locally
```bash
cd server
npm run dev        # reads ../backend-secrets/openai.env, listens on http://localhost:8787/v1
npm test           # 13 tests, OpenAI mocked (no spend)
```
The extension's default server is `http://localhost:8787/v1` (`extension/shared/brand.js`).

## Deploy (recommended: Render, ~$7/mo + $0.25 disk)
1. Put this project in a **private** GitHub repo (the `backend-secrets/` folder is git-ignored — keep it out).
2. Render → **New → Blueprint** → pick the repo. It reads `server/render.yaml` (Docker, health check, 1 GB disk at `/data`, auto-generated `TOKEN_SECRET`).
3. When prompted, paste **`OPENAI_API_KEY`** (and later `CHECKOUT_URL`, `ALLOWED_EXTENSION_IDS`).
4. Open `https://<your-service>.onrender.com/v1/health` → `"aiConfigured": true`.
5. In `extension/shared/brand.js` change one line:
   `defaultProxyBaseUrl: 'https://<your-service>.onrender.com/v1',` then `python3 scripts/make-zip.py`.

**Other hosts** (all use the same `Dockerfile`; set env vars from `.env.example`; mount a volume at `/data`):
- **Railway**: New Project → Deploy from GitHub repo → Root directory `server` → add a Volume at `/data` → Variables: `OPENAI_API_KEY`, `TOKEN_SECRET`, `NODE_ENV=production`. ~$5/mo Hobby.
- **Fly.io**: `cd server && fly launch --copy-config --no-deploy && fly volumes create margin_data --size 1 && fly secrets set OPENAI_API_KEY=... TOKEN_SECRET=$(openssl rand -hex 32) && fly deploy`.
- **Vercel/Netlify-style serverless** isn't a great fit (needs a persistent store); use Render/Railway/Fly, or swap the store for hosted Postgres/Redis first.
- Free tiers (e.g. Render Free) work for a quick test but sleep when idle and have no persistent disk, so daily counts reset on every restart.

## Turning on Pro payments (when ready)
1. Stripe → create a **Payment Link** for "Pro $9.99/mo" → set `CHECKOUT_URL` to it. The server appends `?client_reference_id=<installId>` so the payment maps to that install.
2. Stripe → Developers → Webhooks → endpoint `https://<host>/v1/stripe/webhook`, events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` → copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Optional: `MANAGE_BILLING_URL` = your Stripe customer-portal link.

## Costs (gpt-4o-mini, measured in the real end-to-end run)
- Text solve ≈ 700–1,000 tokens ≈ **$0.0002–0.0004**.
- Snapshot (vision, `IMAGE_DETAIL=high`) ≈ 15k tokens ≈ **$0.0025** (follow-ups on a snapshot re-send the image).
- A free user maxing 5/day ≈ $0.002–0.013/day. Set a monthly **usage limit in the OpenAI dashboard** as a safety net.

## Notes
- Anonymous installs can reset their free quota by reinstalling; `REGISTER_PER_HOUR` limits new installs per IP. Add real sign-in later if abuse shows up.
- Run one instance (in-memory rate limiter + SQLite). For multiple instances, move rate limits and the store to Redis/Postgres.
- Logs are one JSON line per request — no request bodies, tokens or keys.
