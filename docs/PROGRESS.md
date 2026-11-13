# Progress

_Last updated: 2026-11-13_

Legend: `[x]` done & verified · `[~]` in progress / implemented-not-verified · `[ ]` pending · `[!]` blocked

## Current position
**Phase 1 — Backend. Milestones 1–2 complete and verified against a real MongoDB 8.0. Milestone 3 next.**

## Decisions
- [x] **Repositories** (2026-11-13): two repos. `gym-saas-api` (this) and `gym-saas-web` (dashboard + member PWA). Contract = OpenAPI spec.
- [x] **Member login** (2026-11-13): **email sign-in link** (owner's choice). Consequences:
  - Members without an email can't use the member app; front desk must capture emails (M4 form will flag it).
  - A real email provider is needed **before the pilot**, not at M9. Proposed: pull the provider
    integration forward into M4. Needs your choice of provider and a verified sending domain.

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

### M3 — Tenant management (super admin) + audit log
- [ ] Create gym (+ owner invite), update, suspend/activate, branding & theme, settings, slug checks
- [ ] Audited impersonation ("log in as owner")
- [ ] `auditLogs` service + middleware hooks

### M4 — Staff & member management
- [ ] **Real email provider** (moved up from M9: members can't sign in without it)
- [ ] Staff CRUD, deactivate, permission overrides
- [ ] Members CRUD, archive, search, pagination, profile
- [ ] Cloudinary signed uploads (logo, member photo)
- [ ] CSV member import with dry-run + error report
- [ ] Cross-tenant suite for every model

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
