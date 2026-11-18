# Architecture

_Last updated: 2026-11-17 · Phase 1, Milestones 1–9 built_

## 1. Whiteboard assessment

The whiteboard plan is sound for a 3-gym MVP: one app, one database, `tenantId` on every document,
subdomain per gym, Cloudflare in front, Razorpay / Cloudinary / node-cron at the edges, and a
sensible postpone list. The gaps below are the things that would bite during the first pilot.

### Missing architectural components

| # | Gap | Why it matters | Resolution |
|---|-----|----------------|------------|
| 1 | **Where the API lives relative to gym subdomains** | If the API is `api.yourapp.in`, the Host header no longer identifies the gym. | API is served **same-origin** under `/api` on every gym host (`powerhouse.yourapp.in/api/...`). Tenant comes from the host; auth cookies stay host-only. See §3. |
| 2 | **Member login method** | Indian gym members rarely use email; SMS OTP needs DLT registration and per-message cost. | **Decided 2026-11-13: one-time email link** (Resend). Members without email are managed by the front desk without app access. ✅ M2/M4 |
| 3 | **Two different Razorpay flows** | The whiteboard says "you bill each gym monthly" (platform billing). Members paying *their gym* online is a separate flow and needs money to land in the **gym's** account. | Gyms record cash/UPI/card/bank at the desk ✅ M6. Online payments use the gym's **own** Razorpay keys (encrypted at rest), switched on per gym by connecting keys; test keys only until `RAZORPAY_ALLOW_LIVE` ✅ M6. Platform billing stays manual (Razorpay payment links) until ~10 gyms. |
| 4 | **Member import** | Onboarding step 2 ("import from Excel or register book") has no API in the module list. "New gym live in under 1 day" depends on it. | CSV import endpoint with dry-run + per-row error report, all-or-nothing. ✅ M4 |
| 5 | **Receipt numbering** | GST-style receipts need gap-free, per-gym, per-financial-year sequences. | `counters` collection with atomic `$inc` inside the payment transaction ✅ M6 |
| 6 | **Idempotent payments** | Double-tap on "Record payment" or webhook retries create duplicate payments. | `Idempotency-Key` header (required) + unique index; Razorpay ids unique per tenant ✅ M6 |
| 7 | **Job safety** | node-cron in-process runs the job once **per instance**; two instances = duplicate reminders. | Mongo lease lock (`jobLocks`) per job run. No Redis needed ✅ M9 |
| 8 | **"Log in as owner (audited)"** | Impersonation is a privilege-escalation path if done casually. | Short-lived impersonation session, separate claim, banner in UI, every action audited with both actor ids. ✅ M3 |
| 9 | **Time zones** | "Today's attendance", "expires today" must use the gym's day (IST), not UTC. | `settings.timezone` per gym; attendance stores a precomputed local `day`; reports bucket by gym-local day ✅ |
| 10 | **DPDP Act operations** | Risk table says "record consent, export and delete on request" but no component does it. | Consent recorded at registration ✅ M4; owner/member export and owner erase (financial records kept anonymised) ✅ M9 |
| 11 | **Backups / observability** | Not on the board. | Structured logs with request ids ✅; Atlas continuous backup and error tracking (Sentry free tier) at deploy time (M10). |
| 12 | **Frontend tech mismatch** | Whiteboard says "React PWA"; brief says Next.js. | Following the brief: Next.js for both apps (Phase 2/3). |

### Security problems found in the plan

See [SECURITY.md](SECURITY.md) for the full threat list. Headline items:

1. **Tenant from the client.** Solved structurally: tenant comes only from the host; a Mongoose plugin
   forces `tenantId` into every query and **fails closed** when no tenant is in context.
2. **Token replay across gyms.** A Gym B token sent to Gym A's host must be rejected. Tokens will carry
   `tenantId`; auth middleware requires it to equal the resolved host tenant ✅.
3. **Super-admin reach.** Super admins are a separate collection and can only authenticate on the
   platform host (`admin.yourapp.in`), never on a gym host.
4. **Static QR codes.** A screenshot of a member ID QR would let anyone check in. QR passes are
   30-second HMAC-signed tokens with a per-gym key, accepted for ~60–90 s ✅.
5. **JWTs in localStorage** are readable by any XSS. Refresh tokens go in host-only, `HttpOnly`,
   `Secure`, `SameSite=Lax` cookies; access tokens are short-lived (15 min) and kept in memory.
6. **Webhook spoofing.** Razorpay webhooks are verified against the raw body signature and de-duplicated.

## 2. Final backend technology decisions

| Area | Decision | Reason |
|------|----------|--------|
| Runtime | Node.js 22 LTS | Current LTS; native `--env-file`, stable AsyncLocalStorage. |
| Language | **TypeScript** (strict) | Shared types/schemas with both Next.js apps later; catches tenant/ID mix-ups at compile time. |
| HTTP | Express 5 | As specified. v5 forwards async errors natively (no wrapper boilerplate). |
| DB | MongoDB Atlas + Mongoose 9 | As specified. Replica set (Atlas default) enables transactions for payments. |
| Validation | Zod 4 | One schema language for env, requests, and later the frontend forms. |
| Auth | JWT access (15 min) + rotating refresh tokens stored hashed in `sessions` | Revocable sessions, logout everywhere, reuse detection. |
| Passwords | Node `crypto.scrypt` | Memory-hard, built in, no native build step. |
| Logging | pino (JSON) + request ids | Fast, structured, redaction of secrets at the logger. |
| Security | helmet, allow-list CORS, express-rate-limit, `query parser: simple`, `strictQuery` | Spec §9. |
| Jobs | node-cron in-process + Mongo lease lock | Whiteboard choice; no Redis (Rule 6). |
| Docs | OpenAPI 3.1 generated from the Zod schemas | Single source of truth; Milestone 10. |
| Tests | Vitest + Supertest + mongodb-memory-server (replica set) | Real Mongo semantics incl. transactions and unique indexes. |

**Not used, deliberately:** Redis, queues, microservices, Kubernetes, an ORM abstraction over Mongoose.

## 3. Request pipeline and tenancy

```
Browser on powerhouse.yourapp.in
   │  same-origin /api/v1/...
   ▼
Cloudflare (*.yourapp.in, TLS) ──► Next.js app ──proxy /api──► Express API (private; TRUST_PROXY=<Next.js address>)
                                                                  │
 helmet → request id + log → CORS → rate limit → JSON body        │
 → resolveTenant(host)  ── opens AsyncLocalStorage tenant scope ──┤
 → [authenticate: token.tenantId must equal host tenant]          │
 → [authorize: role/permission]                                   │
 → validate(zod) → controller → service                           │
 → Mongoose models with tenantScopePlugin ── tenantId forced ─────┤
 → 404 → error handler (stable envelope, no internals)            ▼
                                                               MongoDB
```

Key properties:

- **Tenant source:** host only (`req.hostname`, which honours `X-Forwarded-Host` only on connections
  from an address `TRUST_PROXY` lists, i.e. the Next.js server). In development `X-Tenant-Slug` can be enabled; config validation forbids it in
  production.
- **Tenant scope:** `runInTenant()` wraps the rest of the request in AsyncLocalStorage. Services never
  pass `tenantId` around by hand.
- **Fail closed:** any tenant-owned query without a scope throws `TenantIsolationError` → logged as
  fatal, returned as an opaque 500.
- **Platform scope:** super-admin and job code must call `runAsPlatform(reason, fn)` explicitly.
- **Tenants collection** is the only unscoped business collection (it is the registry itself).

## 4. Repositories

**Decision (2026-11-13, owner's choice): two repositories.**

| Repo | Contains | Deploys as |
|---|---|---|
| `gym-saas-api` (this repo) | Express + MongoDB backend | API service |
| `gym-saas-web` | Admin dashboard (Phase 2) and member PWA (Phase 3), as two Next.js apps in one repo | Web service(s) |

**The contract between them is the OpenAPI spec** this repo publishes (Milestone 10, served at
`/api/v1/openapi.json`). The web repo generates its TypeScript API types from that spec, so the
frontend never hand-copies backend types and never duplicates business logic. API changes that
break the contract are versioned (`/api/v2`) or released backend-first.

```
gym-saas-api/
├── src/
│   ├── app.ts            # builds the Express app (dependency-injected, testable)
│   ├── server.ts         # process entry: env, DB, listen, graceful shutdown
│   ├── config/           # env schema (zod)
│   ├── db/               # connection
│   ├── lib/              # errors, response envelope, logger, money, dates, csv, mailer, image store
│   ├── middleware/       # cors, validate, error handler, authenticate/authorize, same-origin
│   ├── tenancy/          # host parsing, resolver, context, tenant-scope plugin
│   ├── jobs/             # lease-locked scheduler (node-cron) and job definitions
│   ├── scripts/          # seed, create-indexes, create-platform-admin
│   └── modules/          # feature modules: routes · controller · service · model · schemas
│       ├── health/ tenants/ platform/ auth/ users/ audit/           (M1–M3)
│       ├── staff/ members/ uploads/ counters/                        (M4)
│       ├── plans/ memberships/                                       (M5)
│       ├── payments/  (desk payments, receipts, refunds, Razorpay)   (M6)
│       ├── attendance/                                               (M7)
│       ├── reports/                                                  (M8)
│       └── notifications/ whatsapp/ privacy/                         (M9)
├── tests/                # unit/ http/ integration/ helpers/
├── docs/
└── .github/workflows/ci.yml
```

Each feature module follows the same shape: `*.routes.ts` (wiring + middleware), `*.controller.ts`
(HTTP in/out only), `*.service.ts` (business rules), `*.model.ts` (Mongoose), `*.schemas.ts` (Zod).

## 5. Deployment topology (target)

- **API + Next.js apps:** one small VM or a PaaS (Railway/Render/Fly) in Mumbai region, single instance
  is enough for 3–10 gyms. Health `/health`, readiness `/ready`.
- **DB:** MongoDB Atlas M10 (or M0 for the pilot, upgrade before taking payments) in `ap-south-1`.
- **Edge:** Cloudflare wildcard DNS `*.yourapp.in` + universal SSL. Custom domains later via
  Cloudflare for SaaS (whiteboard risk table).
- Details in [DEPLOYMENT.md](DEPLOYMENT.md).
