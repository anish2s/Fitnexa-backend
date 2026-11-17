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
`JWT_ACCESS_SECRET` (`openssl rand -base64 48`), `MONGODB_URI`, `RESEND_API_KEY`. Changing `JWT_ACCESS_SECRET`
signs everyone out within 15 minutes (their refresh still works and issues new tokens).

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
