# Progress

_Last updated: 2026-11-13_

Legend: `[x]` done & verified · `[~]` in progress / implemented-not-verified · `[ ]` pending · `[!]` blocked

## Current position
**Phase 1 — Backend. Milestones 1–4 complete and verified against a real MongoDB 8.0 (live email and image upload blocked on credentials). Milestone 5 next.**

## Decisions
- [x] **Repositories** (2026-11-13): two repos. `gym-saas-api` (this) and `gym-saas-web` (dashboard + member PWA). Contract = OpenAPI spec.
- [x] **Member login** (2026-11-13): **email sign-in link** (owner's choice). Consequences:
  - Members without an email can't use the member app; front desk must capture emails (M4 form will flag it).
  - A real email provider is needed **before the pilot**, not at M9: pulled forward into M4.
- [x] **Email provider** (2026-11-17): **Resend**, free plan (100/day, 3,000/month).
- [x] **Audit log retention** (2026-11-17): **1 year** (TTL index).
- [x] **Audit log DB permissions** (2026-11-17): app-level append-only is enough for now (accepted risk).

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
- [x] Mailer interface (dev log + test memory transports; real provider pending)
- [x] Seed (2 demo gyms, owner, staff, 3 members each, super admin), `admin:create`, `db:indexes`
- [x] 143 tests passing on real MongoDB; typecheck, lint, build; end-to-end smoke test of the compiled server

### M3 — Tenant management (super admin) + audit log ✅
- [x] Create gym (+ owner invite, in one transaction), list/search/paginate, detail, update, suspend/activate, branding & theme, settings, slug checks (format, reserved, taken, punycode)
- [x] Owner's own gym: `GET/PATCH /gym`, `PATCH /gym/branding` (host gym only)
- [x] Audited impersonation ("log in as owner"): access-token-only session, `imp` claim, reason required, can't change owner credentials or end owner sessions, dies if the admin is disabled
- [x] `auditLogs` (per gym, readable by the owner) + `platformAuditLogs`; append-only at the model layer; field-level changes with email/phone masked; hooks on login, lockout, invite/reset, password change, logout-all, all M3 actions
- [x] 172 tests passing on real MongoDB (29 new M3 integration tests incl. cross-tenant and role checks); typecheck, lint, build

### M4 — Staff & member management ✅ (except two items blocked on credentials)
- [~] **Real email provider: Resend** (moved up from M9). Transport, config validation, failure handling done and tested with a fake API; **blocked** on live delivery until a Resend API key and verified sending domain exist (see DEPLOYMENT.md)
- [x] Staff CRUD, deactivate (ends sessions), activate, re-invite, permission overrides (grantable list only); 11 integration tests incl. IDOR + cross-tenant
- [x] Members CRUD, archive/restore, search, pagination, profile, member self-profile (`/members/me`), consent capture, per-gym member codes, login kept in step with email; 12 integration tests incl. IDOR, cross-tenant, concurrent codes
- [~] Cloudinary signed uploads (logo, app icon, member photo): signing, path checks, photo set/replace/remove with old-image deletion; 13 tests (signing verified against Cloudinary's documented example, network faked). **Blocked** on live upload until Cloudinary credentials exist
- [x] CSV member import: dry run, per-row error report (line + column), in-file and in-gym duplicate checks, Indian date formats, all-or-nothing transaction, consent confirmation; 10 tests
- [x] Cross-tenant suite for **every** model: classifies all models (a new unscoped model fails CI), checks every index starts with `tenantId`, and proves FitZone can't list/count/fetch/aggregate/update/delete Powerhouse rows in any collection

### M5 — Plans & memberships
- [ ] Plans CRUD (days, price, GST inclusive/exclusive)
- [ ] Assign, renew (from expiry or today), cancel, history; derived status; expiring-soon queries

### M6 — Payments & receipts
- [ ] Cash / UPI / card recording with idempotency
- [ ] Receipt numbering (per gym, per FY) + PDF receipt
- [ ] Partial payments / balance due
- [ ] Razorpay order + verification + webhooks (test keys), refunds
- [ ] Transactions for payment + membership + counter

### M7 — Attendance
- [ ] Rotating signed QR pass; staff scan endpoint; manual check-in
- [ ] Duplicate prevention; history; daily report

### M8 — Dashboard statistics & reports
- [ ] KPIs: total/active/new members, revenue (month), today's attendance, pending renewals
- [ ] Reports: revenue, memberships, attendance, growth, renewals (date-range, gym timezone)

### M9 — Jobs, notifications, privacy
- [ ] node-cron + Mongo lease lock; renewal reminder queue with retry
- [ ] WhatsApp `wa.me` link generation
- [ ] DPDP export / erase

### M10 — Hardening & Phase 1 gate
- [ ] OpenAPI/Swagger from Zod schemas
- [ ] Security review against SECURITY.md; dependency audit
- [ ] Deployment instructions verified end to end
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
  172 tests passing (29 new). Not yet smoke-tested against the compiled server.
- **2026-11-17** — Owner decisions: Resend, 1-year audit retention, app-level append-only accepted.
  Added 1-year TTL on audit logs, Resend transport, and fixed a latent account-enumeration path
  (provider errors would have turned 202 into 500 only for registered emails). 181 tests passing.
- **2026-11-17** — M4 built in four commits: staff, members (+ member self-profile, consent, login
  sync, per-gym codes), Cloudinary signed uploads, CSV import; plus a cross-tenant suite over every
  model. 232 tests passing. Blocked on owner: Resend key + domain, Cloudinary credentials.
  Not yet smoke-tested against the compiled server (M3, M4).
  Dev machine moved to Node 22.23.5 (nvm default) and `.npmrc` `engine-strict=true` added, so npm
  refuses to install on an older Node. 232 tests pass on Node 22.
