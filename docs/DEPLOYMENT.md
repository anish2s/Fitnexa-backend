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
`JWT_ACCESS_SECRET` (`openssl rand -base64 48`), `MONGODB_URI`. Changing `JWT_ACCESS_SECRET`
signs everyone out within 15 minutes (their refresh still works and issues new tokens).

## Blocked until Milestone 9
Production refuses to start until a real email provider is configured (`MAIL_TRANSPORT`), because
members sign in by email link.
