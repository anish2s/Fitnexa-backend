# Deployment

_Verified end to end on 2026-11-17 against a clean clone in production mode behind a simulated proxy
(see "Verification" below). Not yet run on a real host: nothing is deployed, and production actions
need the owner's explicit approval (project Rule 7)._

## Target
| Piece | Choice |
|---|---|
| API | Node 22, single instance, Mumbai region (Railway / Render / Fly / small VM) |
| DB | MongoDB Atlas, `ap-south-1`, replica set; continuous backup on before real payments |
| DNS/TLS | Cloudflare: `yourapp.in`, wildcard `*.yourapp.in`, proxied, SSL Full (strict) |
| Images | Cloudinary (signed uploads, per-gym folders) |

## Routing
All gym traffic is `https://<gym>.yourapp.in`:

```
visitor ──► Cloudflare ──► Next.js server (dashboard) ──► API (private)
```

The Next.js server proxies `/api/*` to the API and calls it while rendering pages. On every call it
**overwrites** `X-Forwarded-Host` (the gym's host) and `X-Forwarded-For` (the visitor's IP, worked
out from its own trusted hops; see the web repo's `docs/DEPLOYMENT.md`). The API uses them for the gym,
for rate limits per visitor and for audit IPs.

**Requirement: the API must be reachable only through the Next.js server.** Run it on a private
network / internal service address with no public route, and set `TRUST_PROXY` to the Next.js
server's address(es) only, e.g. `TRUST_PROXY=uniquelocal` (any private address) or the exact
subnet/IP your host gives the web service. Then:
- a request that really comes from the Next.js server is attributed to the visitor it names;
- anything else that reaches the API is identified by its own address; its `X-Forwarded-*` headers are
  ignored, so it can neither pick a gym by header nor dodge rate limits by inventing IPs
  (`tests/http/app.test.ts`, "client IP behind the Next.js server").

Production refuses a hop count (`TRUST_PROXY=1`/`2`): a count trusts whoever connects.
Without a forwarded IP every visitor would share the Next.js server's single rate-limit allowance
(300 requests/min), so a busy gym would lock everyone out: don't "fix" that by raising the limit.

### Member and staff addresses (Phase 3)
Members use the gym's main address (`https://<gym>.yourapp.in`, the member app); owners and staff use
a separate staff address served by the dashboard. The staff domain is not decided yet, so it is a
setting (see docs/API.md, "Member and staff addresses"):

| Variable | Example | Notes |
|---|---|---|
| `STAFF_BASE_DOMAINS` | `staff.yourapp.in` (locally `staff.localhost`) | `<gym>.<staff base>` is the same gym's staff site. Empty = no split: the main address serves everyone (as before). Must not repeat a `BASE_DOMAINS` entry. With it set, members are refused on staff sites and staff on member sites (`403 WRONG_SITE`). |
| `STAFF_APP_URL_TEMPLATE` | `https://{slug}.staff.yourapp.in` | Links in owner/staff emails (password reset, invites). Default: `GYM_APP_URL_TEMPLATE`. https in production. |
| `GYM_APP_URL_TEMPLATE` | `https://{slug}.yourapp.in` | Member links: email sign-in, WhatsApp messages, renewal reminders. |

Add the staff base to DNS/TLS (Cloudflare: a proxied wildcard for `*.staff.yourapp.in` needs a
certificate covering that level) and to `CORS_ORIGINS` if a browser calls the API from it directly.

Development/e2e only: `MAIL_TRANSPORT=file` appends each email as a JSON line
`{ at, kind, to, subject, text }` to `MAIL_FILE` (default `tmp/mail.jsonl`, relative to the backend
folder), so automated tests can read sign-in links. Production refuses it, like `log` and `memory`.

## Environment
See `.env.example` and the table above. Production requirements enforced at startup:
- `NODE_ENV=production`, `ALLOW_TENANT_HEADER=false`, `CORS_ORIGINS` set.
- Secrets only in the host's secret store, never in git.
- Swagger UI (`/api/docs`) is off in production; set `ENABLE_API_DOCS=true` only if you want it
  public. `/api/v1/openapi.json` is always served (it describes routes, never data).

## Build & run
Node 22 (`.nvmrc`; `npm ci` refuses other versions).
```bash
npm ci                     # dev tools are needed to build
npm run build
npm prune --omit=dev       # ship runtime dependencies only (~140 packages, ~50 MB)
NODE_ENV=production node dist/server.js
```
Ship `dist/`, `node_modules/` and `package.json` together. Health check path `/health`; readiness
`/ready`. Graceful shutdown on SIGTERM: stops the scheduler, drains for up to 10 s, exits 0.

The `*:prod` scripts and `node dist/server.js` read configuration from the **process environment**
(the host's secret store), not from a `.env` file. If you keep an env file for a VM, **quote values
with spaces or `<>`**, e.g. `MAIL_FROM="Fitexaa <no-reply@mail.yourapp.in>"`: an unquoted line stops
`set -a; . file` from loading everything after it.

## Release steps
`autoIndex` is off in production. On each release:
```bash
npm run db:indexes:prod                       # additive only; never drops an index
```
First deploy only, create your super admin (password from ADMIN_PASSWORD or printed once):
```bash
npm run admin:create:prod -- --email you@yourapp.in --name "Your Name"
```
Never run `npm run seed` against production (it refuses). If DATABASE.md lists an index migration
newer than the database, run it before `db:indexes`.

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
   `CLOUDINARY_FOLDER=fitexaa-prod` (dev defaults to `fitexaa-dev`, so the two never mix).
No upload preset or CORS setup is needed: uploads are signed per request.
Leave `CLOUDINARY_API_URL` unset in production (it refuses any value but `https://api.cloudinary.com`).
It exists for the dashboard's e2e run, which points the API's own Cloudinary calls (resource lookups,
deletes) at a local mock with fake credentials, so test runs never touch a real account.

## Online payments (Razorpay)
Optional; desk payments never need it.
1. `PAYMENTS_ENCRYPTION_KEY=$(openssl rand -base64 32)` in the secret store. **Back it up**: losing or
   rotating it means every gym must re-enter its Razorpay keys.
2. Leave `RAZORPAY_ALLOW_LIVE=false` until the owner approves real charges. Only `rzp_test_` keys
   are accepted until then.
3. Each gym owner: Razorpay dashboard → API keys (test mode) → paste Key Id + Key Secret in the gym
   settings (until the dashboard exists: `npm run razorpay:connect -- --gym <subdomain>`, which asks for
   them in the terminal, hides the secret, and prints a generated webhook secret once); Webhooks → add the URL shown in settings, a secret of their choice (same one in
   settings), events `payment.captured`, `order.paid`, `refund.processed`, `refund.failed`.

## Email (Resend)
Production refuses to start without a real email provider, because members sign in by email link.
Provider: **Resend** (owner's choice, 2026-11-17), free plan (100 emails/day, 3,000/month).

One-time setup (needs the owner, not done yet):
1. Create a Resend account and add the sending domain (e.g. `mail.yourapp.in`).
2. Add the DNS records Resend shows (SPF, DKIM, and a DMARC record) in Cloudflare; wait for "Verified".
3. Create an API key with **sending access only**, scoped to that domain.
4. Set `MAIL_TRANSPORT=resend`, `RESEND_API_KEY=re_…`, `MAIL_FROM="Fitexaa <no-reply@mail.fitexaa.com>"`
   (the verified domain). Gym emails keep this address but show the gym's name as the sender, so
   members never see "Fitexaa".
5. `MAIL_ENABLED_KINDS`: leave unset for sign-in emails only (`magic_link,password_reset,invite`,
   owner's decision 2026-11-19). Add `renewal_reminder` when reminders should go out.
6. Do **not** set `MAIL_ALLOWED_RECIPIENTS` (a development safety net) or `RESEND_DEBUG`.

Sending uses the official `resend` SDK (pinned), always against `https://api.resend.com`
(`RESEND_BASE_URL` is ignored, so the key can't be redirected). Production refuses to start with
`log`/`memory`, without a key, with a `localhost` sender, with `MAIL_ALLOWED_RECIPIENTS` set, or
without `magic_link` in `MAIL_ENABLED_KINDS` (members sign in by email).

A provider rejection, outage or 10 s timeout doesn't break anything. Magic-link and forgot-password
still answer `202`, and the failure is logged as `Email could not be sent` with the error name and
status only. Gym creation reports `inviteError: "send_failed"` so the invite can be resent.
Reminders retry with backoff. Kinds that are not enabled are logged as `Email skipped: kind not
enabled`, and a reminder is then recorded as `skipped` (`reason: kind_not_enabled`). Watch the daily
quota: past 100/day Resend refuses mail until the next day.

## Renamed to Fitexaa (2026-11-18): effect on existing setups
Defaults changed; anything set explicitly in an env file is untouched.

| Identifier | Was | Now | Effect on an existing install |
|---|---|---|---|
| JWT issuer (`JWT_ISSUER` default) | `gym-saas-api` | `fitexaa-backend` | Access tokens issued before the deploy are refused (401); clients refresh once and carry on. Refresh tokens are server-side sessions, so nobody is signed out. |
| JWT audience (in code) | `gym-saas` | `fitexaa` | Same as above, same single refresh. |
| `CLOUDINARY_FOLDER` default | `gym-saas-dev` | `fitexaa-dev` (prod example `fitexaa-prod`) | Only **new** uploads go to the new folder. Existing photos and logos keep their stored URLs and can still be replaced or deleted. Moving old files is optional (Cloudinary rename); nothing in the app needs it. |
| Database name in `.env.example` | `gym_saas` | `fitexaa` | Example only. An env file that already names `gym_saas` keeps using it. Switching an existing install to a new name means copying the data first (`mongodump`/`mongorestore` or Atlas), otherwise the app starts on an empty database. |
| `MAIL_FROM` default name | `Gym App` | `Fitexaa` | Gym emails show the **gym's** name as the sender either way (address from `MAIL_FROM`). |

## Verification (2026-11-17, local)
Clean `git clone` → `npm ci` → `npm run build` → `npm prune --omit=dev`, production environment
(`NODE_ENV=production`, Resend transport with a placeholder key, https links, `TRUST_PROXY=1`; production now requires proxy addresses, see Routing), a fresh
MongoDB replica set, requests sent the way a proxy forwards them (internal `Host`, real host in
`X-Forwarded-Host`, `X-Forwarded-Proto: https`):

| Step | Result |
|---|---|
| Misconfigured production env (no CORS, http links, dev mail) | refused at startup, every problem listed, exit 1 |
| `db:indexes:prod`, `admin:create:prod` (password from `ADMIN_PASSWORD`, never printed) | ✅ |
| `seed` with `NODE_ENV=production` | refused ✅ |
| `/health`, `/ready` (database up) | ✅ |
| Gym resolved from `X-Forwarded-Host`; HSTS and security headers | ✅ |
| Owner login; refresh cookie `__Host-gym_rt`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain` | ✅ |
| Refresh from the gym's own origin ✅; from another gym's origin refused (CSRF) ✅ | ✅ |
| CORS: own origin allowed; another gym's and foreign origins refused | ✅ |
| Cross-gym token refused; `no-store` on API responses; JSON 404s without internals | ✅ |
| Super admin (from `admin:create:prod`) signs in on the platform host | ✅ |
| Swagger UI off in production (unless `ENABLE_API_DOCS=true`; assets served locally, no CDN); OpenAPI served | ✅ |
| Scheduler started; no secrets/passwords/tokens in logs; member search terms redacted | ✅ |
| SIGTERM → "Shutting down" → exit code 0 | ✅ |

Still to do on the real host (needs the owner): DNS/TLS (Cloudflare), `TRUST_PROXY` set to the web
service's private address and the API kept off the public internet, Atlas backups, error tracking, Resend domain, then one smoke test there.
