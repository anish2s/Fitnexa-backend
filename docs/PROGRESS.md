# Progress

_Last updated: 2026-11-12_

Legend: `[x]` done & verified · `[~]` in progress / implemented-not-verified · `[ ]` pending · `[!]` blocked

## Current position
**Phase 1 — Backend. Milestone 1 complete (verified with unit + HTTP tests). Milestone 2 next.**

## Open decisions (need your input)
- [ ] **Member login method** (blocks M2 design for the member role):
  - A. Phone + password, set via an activation link the front desk shares on WhatsApp (`wa.me`). Free, works now. _(recommended for MVP)_
  - B. Phone + SMS OTP. Best UX, but needs DLT registration + an SMS provider (~₹0.15–0.25 per OTP).
  - C. Email magic link. Free, but many members won't have or check email.

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
- [~] 13 DB integration tests written (cross-tenant attacks, per-gym uniqueness, tenant lookup) — **skipped in the build sandbox** (no MongoDB available); must be run on a machine with MongoDB
- [x] Docs: ARCHITECTURE, DATABASE, SECURITY, DEVELOPMENT, DEPLOYMENT (draft), API, DESIGN

### M2 — Authentication & RBAC
- [ ] `platformAdmins`, `users`, `sessions`, `authTokens` models
- [ ] scrypt password hashing
- [ ] Login (tenant users on gym host; super admin on platform host), refresh rotation, logout, logout-all, `me`
- [ ] Forgot / reset password (email interface; dev transport logs the link)
- [ ] `authenticate` middleware: token tenant == host tenant; `passwordChangedAt` check
- [ ] `authorize(permission)` with role → permission map (owner / staff / member / super admin)
- [ ] Login rate limit + lockout
- [ ] Seed script: 2 demo gyms with owner, staff, members
- [ ] Tests: auth flows, cross-tenant token replay, role denials

### M3 — Tenant management (super admin) + audit log
- [ ] Create gym (+ owner invite), update, suspend/activate, branding & theme, settings, slug checks
- [ ] Audited impersonation ("log in as owner")
- [ ] `auditLogs` service + middleware hooks

### M4 — Staff & member management
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
- [ ] WhatsApp `wa.me` link generation; email provider interface
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
