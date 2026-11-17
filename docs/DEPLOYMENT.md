# Deployment (draft — verified end to end in Milestone 10)

Nothing is deployed. Production actions require explicit approval (project Rule 8).

## Target
| Piece | Choice |
|---|---|
| API | Node 22, single instance, Mumbai region (Railway / Render / Fly / small VM) |
| DB | MongoDB Atlas, `ap-south-1`, replica set; continuous backup on before real payments |
| DNS/TLS | Cloudflare: `yourapp.in`, wildcard `*.yourapp.in`, proxied, SSL Full (strict) |
| Images | Cloudinary (signed uploads, per-gym folders) |

## Routing
All gym traffic is `https://<gym>.yourapp.in`. The Next.js apps (Phase 2/3) rewrite `/api/*` to the
API service and forward the original host as `X-Forwarded-Host`. Set `TRUST_PROXY` to the number of
proxies in front of the API (e.g. Cloudflare → Next.js → API = `2`) so `req.hostname` and client IPs
are taken from the right hop and can't be spoofed from outside.

## Environment
See `.env.example`. Production requirements enforced at startup:
- `NODE_ENV=production`, `ALLOW_TENANT_HEADER=false`, `CORS_ORIGINS` set.
- Secrets only in the host's secret store, never in git.

## Build & run
```bash
npm ci
npm run build
NODE_ENV=production node dist/server.js
```
Health check path `/health`; readiness `/ready`. Graceful shutdown on SIGTERM (10 s drain).

## Release steps
`autoIndex` is off in production. On each release:
```bash
npm run db:indexes:prod                       # additive only; never drops an index
```
First deploy only, create your super admin (password from ADMIN_PASSWORD or printed once):
```bash
npm run admin:create:prod -- --email you@yourapp.in --name "Your Name"
```
Never run `npm run seed` against production (it refuses).

## Required secrets
`JWT_ACCESS_SECRET` (`openssl rand -base64 48`), `MONGODB_URI`, `RESEND_API_KEY`.
Optional: `QR_SIGNING_SECRET` (attendance passes; derived from the JWT secret if unset),
`PAYMENTS_ENCRYPTION_KEY`, Cloudinary keys. Changing `JWT_ACCESS_SECRET`
signs everyone out within 15 minutes (their refresh still works and issues new tokens).

## Scheduled jobs
Run inside the API process (`JOBS_ENABLED=true`, the default). With several instances each job still
runs once per tick (MongoDB lease in `jobLocks`). Schedules are UTC; each gym's rules use its own
time zone.

| Job | Schedule | Does |
|---|---|---|
| `renewal-reminders-scan` | hourly at :15 | queues renewal reminders per active gym |
| `notifications-dispatch` | every 5 min | sends due reminders 09:00–20:00 gym time, with retries |

Check `jobLocks` for `lastFinishedAt` / `lastError` / `lastSummary` per job. Reminders send real email
only once `MAIL_TRANSPORT=resend` is configured (project Rule 7: owner approval first).

## Image uploads (Cloudinary)
Optional at boot: without credentials, upload endpoints return `503 UPLOADS_NOT_CONFIGURED`.
1. Create a Cloudinary account (free plan is enough for the pilot).
2. Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (all three) and
   `CLOUDINARY_FOLDER=gym-saas-prod` (dev defaults to `gym-saas-dev`, so the two never mix).
No upload preset or CORS setup is needed: uploads are signed per request.

## Online payments (Razorpay)
Optional; desk payments never need it.
1. `PAYMENTS_ENCRYPTION_KEY=$(openssl rand -base64 32)` in the secret store. **Back it up**: losing or
   rotating it means every gym must re-enter its Razorpay keys.
2. Leave `RAZORPAY_ALLOW_LIVE=false` until the owner approves real charges. Only `rzp_test_` keys
   are accepted until then.
3. Each gym owner: Razorpay dashboard → API keys (test mode) → paste Key Id + Key Secret in the gym
   settings; Webhooks → add the URL shown in settings, a secret of their choice (same one in
   settings), events `payment.captured`, `order.paid`, `refund.processed`, `refund.failed`.

## Email (Resend)
Production refuses to start without a real email provider, because members sign in by email link.
Provider: **Resend** (owner's choice, 2026-11-17), free plan (100 emails/day, 3,000/month).

One-time setup (needs the owner, not done yet):
1. Create a Resend account and add the sending domain (e.g. `mail.yourapp.in`).
2. Add the DNS records Resend shows (SPF, DKIM, and a DMARC record) in Cloudflare; wait for "Verified".
3. Create an API key with **sending access only**, scoped to that domain.
4. Set `MAIL_TRANSPORT=resend`, `RESEND_API_KEY=re_…`, `MAIL_FROM="Gym App <no-reply@mail.yourapp.in>"`.

Startup refuses `resend` without a key or with a `localhost` sender. A provider outage doesn't break
sign-in endpoints: magic-link and forgot-password still answer `202` (the failure is logged as
`Email could not be sent`), and gym creation reports `inviteError: "send_failed"` so the invite can
be resent. Watch the daily quota: past 100/day Resend refuses mail until the next day.
