# Progress

_Last updated: 2026-11-13_

Legend: `[x]` done & verified · `[~]` in progress / implemented-not-verified · `[ ]` pending · `[!]` blocked

## Current position
**Phase 1 — Backend. Milestones 1–9 complete and verified against a real MongoDB 8.0; Cloudinary verified live (live email and Razorpay round trip still need credentials). Milestone 10 (hardening + Phase 1 gate) next.**

## Decisions
- [x] **Repositories** (2026-11-13): two repos. `gym-saas-api` (this) and `gym-saas-web` (dashboard + member PWA). Contract = OpenAPI spec.
- [x] **Member login** (2026-11-13): **email sign-in link** (owner's choice). Consequences:
  - Members without an email can't use the member app; front desk must capture emails (M4 form will flag it).
  - A real email provider is needed **before the pilot**, not at M9: pulled forward into M4.
- [x] **Email provider** (2026-11-17): **Resend**, free plan (100/day, 3,000/month).
- [x] **Audit log retention** (2026-11-17): **1 year** (TTL index).
- [x] **Audit log DB permissions** (2026-11-17): app-level append-only is enough for now (accepted risk).
- [ ] **Open (owner to decide later)**: should front-desk staff see revenue on the dashboard? Built: no (owner and `reports:read` only; one-line change).
- [ ] **Open (owner to decide later)**: renewal rate counts late renewals as renewed and ignores memberships not yet ended (late renewals also shown separately). Built that way.
- [x] **Plan lengths** (2026-11-17): calendar months only: monthly, quarterly, half-yearly, yearly. Ends the day before the same date N months later; short months run to month end.

## Phase 1 milestones

### M1 — Foundation & tenant isolation core ✅
- [x] Standalone backend repo, TypeScript strict, ESLint, Prettier, Vitest
- [x] Validated environment config (fails fast; production guards)
- [x] Express app factory: helmet, request ids, pino logging, CORS allow-list, rate limit, JSON limits
- [x] Standard response + error envelope; central error handler
- [x] Host → tenant resolution (subdomain, custom domain, platform hosts, dev header fallback)
- [x] AsyncLocalStorage tenant context; `runInTenant` / `runAsPlatform`
- [x] `tenantScopePlugin` — fail-closed tenant enforcement on all query types
- [x] Tenant model (branding incl. default theme, settings, subscription)
- [x] Public branding endpoint `GET /api/v1/public/tenant`
- [x] `/health`, `/ready`
- [x] 53 tests passing (unit + HTTP), typecheck, lint, build
- [x] 13 DB integration tests (cross-tenant attacks, per-gym uniqueness, tenant lookup): passing on MongoDB 8.0 since 2026-11-13; they exposed and fixed a scope bug in `runInTenant`
- [x] Docs: ARCHITECTURE, DATABASE, SECURITY, DEVELOPMENT, DEPLOYMENT (draft), API, DESIGN

### M2 — Authentication & RBAC ✅
- [x] `platformAdmins`, `users`, `sessions` / `platformSessions`, `authTokens` models
- [x] scrypt password hashing with upgradeable parameters
- [x] Owner/staff login (email or phone), super admin login on platform host only
- [x] **Member sign-in by one-time email link** (single use, 15 min, throttled, gym-bound)
- [x] Rotating refresh tokens in HttpOnly cookies, theft detection, logout, logout-all, session list/revoke, `me`
- [x] Forgot / reset password, change password; invite completion (used by M3/M4)
- [x] `authenticate`: token gym == host gym; live session + live role check on every request
- [x] `authorize(permission)` with role → permission map and limited staff grants
- [x] Login rate limits (IP+gym, IP+gym+account) + account lockout
- [x] CORS tightened to same-gym origins; CSRF guard on cookie endpoints
- [x] Mailer interface (dev log + test memory transports; Resend transport added in M4)
- [x] Seed (2 demo gyms, owner, staff, 3 members each, super admin), `admin:create`, `db:indexes`
- [x] 143 tests passing on real MongoDB; typecheck, lint, build; end-to-end smoke test of the compiled server

### M3 — Tenant management (super admin) + audit log ✅
- [x] Create gym (+ owner invite, in one transaction), list/search/paginate, detail, update, suspend/activate, branding & theme, settings, slug checks (format, reserved, taken, punycode)
- [x] Owner's own gym: `GET/PATCH /gym`, `PATCH /gym/branding` (host gym only)
- [x] Audited impersonation ("log in as owner"): access-token-only session, `imp` claim, reason required, can't change owner credentials or end owner sessions, dies if the admin is disabled
- [x] `auditLogs` (per gym, readable by the owner) + `platformAuditLogs`; append-only at the model layer; field-level changes with email/phone masked; hooks on login, lockout, invite/reset, password change, logout-all, all M3 actions
- [x] 172 tests passing on real MongoDB (29 new M3 integration tests incl. cross-tenant and role checks); typecheck, lint, build

### M4 — Staff & member management ✅ (live email still needs Resend credentials)
- [~] **Real email provider: Resend** (moved up from M9). Transport, config validation, failure handling done and tested with a fake API; **blocked** on live delivery until a Resend API key and verified sending domain exist (see DEPLOYMENT.md)
- [x] Staff CRUD, deactivate (ends sessions), activate, re-invite, permission overrides (grantable list only); 11 integration tests incl. IDOR + cross-tenant
- [x] Members CRUD, archive/restore, search, pagination, profile, member self-profile (`/members/me`), consent capture, per-gym member codes, login kept in step with email; 12 integration tests incl. IDOR, cross-tenant, concurrent codes
- [x] Cloudinary signed uploads (logo, app icon, member photo): signing, path checks, photo set/replace/remove with old-image deletion; 13 tests. **Verified live 2026-11-17** against the owner's Cloudinary account (dev folder): signed upload, tampered path refused, no overwrite, delivery URL serves, delete removes it (7/7)
- [x] CSV member import: dry run, per-row error report (line + column), in-file and in-gym duplicate checks, Indian date formats, all-or-nothing transaction, consent confirmation; 10 tests
- [x] Cross-tenant suite for **every** model: classifies all models (a new unscoped model fails CI), checks every index starts with `tenantId`, and proves FitZone can't list/count/fetch/aggregate/update/delete Powerhouse rows in any collection

### M5 — Plans & memberships ✅
- [x] Plans CRUD + archive/restore (monthly/quarterly/half-yearly/yearly, integer-paise price, GST inclusive/exclusive/none at 0/5/12/18/28%, GST only with a GSTIN, unique live names); 8 integration + 6 money unit tests
- [x] Sell, renew (from expiry or today), cancel, history (staff + member app); derived status; gym-wide status lists; expiring-soon excluding renewed/archived; no overlaps (race-safe); price snapshot; 13 integration tests

### M6 — Payments & receipts ✅ (live Razorpay round trip pending a test account)
- [x] Cash / UPI / card / bank transfer recording; required Idempotency-Key (replay, conflict on reuse, race-safe); sell + collect in one transaction
- [x] Receipt numbering per gym per Indian FY, gap-free (counter in the payment transaction)
- [x] PDF receipt (staff + member's own), CGST/SGST split; content verified by decoding the PDF text in tests
- [x] Partial payments / balance due / payment status / dues list; atomic no-overpay guard (5 parallel → 2 accepted)
- [x] Desk refunds: partial/full, numbered per FY, idempotent, atomic cap, balance in the same transaction, `payments:refund` only
- [x] Razorpay (each gym's own account, test keys only unless allowed): encrypted keys, orders (desk + member app), signature verification, signed webhooks with de-dup, gateway refunds with reserve/revert; 22 tests against a fake gateway
- [~] Live Razorpay round trip with real test keys: **needs a Razorpay test account**
- [x] Transactions for payment + membership + counter

### M7 — Attendance ✅
- [x] Rotating signed QR pass (per-gym key, 30 s windows, ~60–90 s validity); staff scan; manual check-in; admission needs an active membership (clear reason otherwise); desk sees photo + dues
- [x] Duplicate prevention (unique per member per day; parallel scans → 1); gym-wide day list, member history, member's own history; daily report (QR/manual, busy hours, attendance rate); 14 tests + 7/7 compiled-server smoke

### M8 — Dashboard statistics & reports ✅
- [x] KPIs: total/active/new members, revenue this/last month (owner/reports:read only), today's attendance + rate, pending renewals (expiring soon, recently lapsed), dues outstanding
- [x] Reports: revenue, memberships, attendance, growth, renewals: gym-local date range ≤ 366 days, day/week/month, zero-filled; 11 integration + 5 unit tests; compiled-server smoke 8/8

### M9 — Jobs, notifications, privacy ✅
- [x] node-cron + Mongo lease lock (jobs run once across instances); renewal reminder queue (expiring + expired) with retries/backoff, send hours, send-time re-checks, owner queue view/retry/cancel, on/off setting; 4 runner + 8 reminder tests
- [x] WhatsApp `wa.me` links (renewal, payment due, welcome, custom); ready link on every expiring-soon row; 7 tests
- [x] DPDP export (owner + member self) and erase (owner-only, confirmed, irreversible; personal data removed, financial/attendance records kept anonymised, photo deleted); 6 tests

### M10 — Hardening & Phase 1 gate
- [x] OpenAPI 3.1 generated from the real routers + Zod schemas (99 operations, permissions, headers, CSV/PDF bodies); served at `/api/v1/openapi.json`, committed as `docs/openapi.json` with a drift test; Swagger UI at `/api/docs` in development
- [x] Security review against SECURITY.md + automated route audit over every route (public allow-list, permissions, platform admin, id/body validation, idempotency, impersonation blocks); fixed: PII in request-log query strings, default `no-store`; dependency audit 0 vulnerabilities, in-range updates; no secrets in repo or history
- [x] Deployment instructions verified end to end **locally** (clean clone, production build with runtime deps only, production env, simulated proxy, 21 checks, graceful shutdown exit 0); doc fixed (Rule 7, prune step, ship package.json, env-file quoting). Real host still needs the owner (DNS/TLS, Atlas, Resend)
- [ ] Phase 1 completion report

## Schedule reassessment
No existing code, so the plan stands. At 2–3 h/day, M2–M10 is roughly 4–5 weeks, which fits the
brief's weeks 1–5. The whiteboard's **Week 0–2 "validate: pitch 15 gyms with a clickable mockup"**
can run in parallel: a static, clickable mockup for pitching is not dashboard development and doesn't
depend on the backend.

## Session log
- **2026-11-12** — Environment inspected (no repo; Node 22, npm 10; no MongoDB reachable from the build
  sandbox). Architecture assessed. M1 built and verified: 53 passed, 13 DB tests skipped (no MongoDB).
- **2026-11-13** — Split into two repositories. Obtained a MongoDB 8.0 binary from conda-forge; the
  real-DB isolation suite now runs and found a `runInTenant` scope bug (lazy queries ran outside the
  scope; failed closed, no leak) — fixed. M2 built: 143 tests passing, compiled server smoke-tested
  with curl (owner login, cross-gym token rejected, refresh, member email link, super admin).
  M3 built: gym management console API, owner settings, audit log, audited impersonation.
  172 tests passing (29 new).
- **2026-11-17** — Owner decisions: Resend, 1-year audit retention, app-level append-only accepted.
  Added 1-year TTL on audit logs, Resend transport, and fixed a latent account-enumeration path
  (provider errors would have turned 202 into 500 only for registered emails). 181 tests passing.
- **2026-11-17** — M4 built in four commits: staff, members (+ member self-profile, consent, login
  sync, per-gym codes), Cloudinary signed uploads, CSV import; plus a cross-tenant suite over every
  model. 232 tests passing. Blocked on owner: Resend key + domain, Cloudinary credentials.
  Dev machine moved to Node 22.23.5 (nvm default) and `.npmrc` `engine-strict=true` added, so npm
  refuses to install on an older Node. 232 tests pass on Node 22.
- **2026-11-17** — M5: plans (GST inclusive/exclusive/none) and memberships (sell, renew, cancel,
  derived status, expiring soon). Found and fixed an isolation gap while building it: the tenant
  plugin scoped only the top level of an aggregate, so a `$lookup`/`$unionWith`/`$graphLookup` into
  another collection could read other gyms' rows. Nothing used joins before M5, so no data was
  exposed. Joins are now scoped automatically, with a real-DB test that fails without the fix.
  260 tests passing.
- **2026-11-17** — M1–M5 review: smoke-tested the compiled server (`dist/`) over real HTTP against a
  fresh MongoDB replica set with the real seed: 36/36 checks across M1–M5 (host routing, logins,
  cross-gym token refusal, email link, gym creation + invite, impersonation, suspension, audit log,
  staff, members, CSV import, uploads-not-configured, plans in months, sell/overlap/renew/expiring,
  isolation, no secrets in logs). Only open M1–M5 items: live Resend and Cloudinary (credentials).
- **2026-11-17** — M6 in four commits: desk payments (idempotent, balances, gap-free receipts per FY,
  sell + collect), PDF receipts, refunds, Razorpay (per-gym encrypted keys, orders, verify, signed
  webhooks, gateway refunds). Test-mode only; nothing talks to Razorpay in tests. 313 tests passing.
  Compiled-server smoke test 14/14: dues, desk payment, idempotent retry, overpay refused, PDF
  receipt, refund permissions, refund numbering, totals, Razorpay key connect (live refused), signed
  vs forged webhook (raw-body HMAC), cross-gym read, no secrets in logs.
- **2026-11-17** — M7 attendance: rotating QR pass, scan/manual check-in, one visit per day, history,
  daily report. 327 tests passing; compiled-server smoke 7/7.
- **2026-11-17** — M8 dashboard + five reports. Revenue on the dashboard is owner-only by default
  (front desk sees everything else). 343 tests passing; compiled-server smoke 8/8.
- **2026-11-17** — M9: job runner with Mongo lease lock, renewal reminder emails (queue, retries,
  send hours), WhatsApp links, DPDP export/erase. 368 tests passing. Local dev databases need one
  index migration (see DATABASE.md "Index migrations").
  Compiled-server smoke 8/8 (scheduler start, WhatsApp links, export, erase permissions, erase,
  reminder queue) and a real cron tick observed: `notifications-dispatch` took the lease, ran for
  both gyms with no failures and released it.
- **2026-11-17** — Owner added Cloudinary credentials. Read-only ping OK; live round trip with the
  app's own code 7/7: signed upload accepted at the server-chosen path, the same signature with a
  different path (another gym's folder) refused by Cloudinary, overwrite blocked, delivery URL serves
  the image, app delete removes it. Config now rejects truncated API secrets at startup.
- **2026-11-17** — M1–M9 audit: gate green (369 tests); `npm audit` 0 vulnerabilities (runtime and
  dev, after a non-breaking `npm audit fix` of dev tooling); CI now also checks formatting; stale docs
  updated (ARCHITECTURE status/tree, DATABASE plan note, SECURITY/DATABASE headers, README).
  Remaining before the Phase 1 gate: live Resend email, live Razorpay test payment (both need
  credentials), two open owner decisions, and M10.
