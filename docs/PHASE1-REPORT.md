# Phase 1 completion report — Backend API

_Prepared 2026-11-17 for the owner's approval. Phase 2 (dashboard) starts only after approval._

## Summary

The backend for Fitexaa, the multi-gym SaaS, is built: one API, one MongoDB, every gym isolated on its own
subdomain. Milestones 1–10 are complete. **398 automated tests pass against a real MongoDB**, the
built server has been smoke-tested after every milestone, Cloudinary has been verified live, and the
deployment steps were rehearsed end to end in production mode.

Three things cannot be verified until you provide accounts: **live email (Resend)**, **a live
Razorpay test payment**, and **the real hosting environment**. Everything else is done and tested.

**Recommendation:** approve Phase 1 and start Phase 2 (the dashboard) in parallel with setting up
Resend and Razorpay; neither blocks dashboard work.

## What a gym gets

| Area | What works | Status |
|---|---|---|
| Gyms & isolation | Each gym on `<gym>.yourapp.in`; no gym can read or change another's data (proven for every one of the 13 gym collections) | ✅ tested |
| Sign-in | Owners/staff by password (email or phone); members by one-time email link; sessions, logout everywhere, lockout, password reset | ✅ tested · email delivery 🟡 needs Resend |
| Super admin | Create/suspend/activate gyms, owner invites, branding, audited "log in as owner" | ✅ tested |
| Audit log | Every sensitive action, readable by the gym owner, personal values masked, kept 1 year | ✅ tested |
| Team | Staff invite, permissions, deactivate (signs out everywhere) | ✅ tested |
| Members | Register (with DPDP consent), search, archive, photos, CSV import with dry run | ✅ tested · photos ✅ verified live (Cloudinary) |
| Plans | Monthly / quarterly / half-yearly / yearly; GST inclusive/exclusive/none | ✅ tested |
| Memberships | Sell, renew (from expiry or today), cancel, history, expiring soon; no overlaps | ✅ tested |
| Payments | Cash/UPI/card/bank; part payments; no double charges; gap-free receipt numbers per financial year; PDF receipts with CGST/SGST; refunds | ✅ tested |
| Online payments | Each gym's own Razorpay (keys encrypted), member pays in app, signed webhooks, gateway refunds; a member paying twice for one order is never applied twice, the owner is alerted to refund it; test keys only | ✅ tested with a simulated Razorpay · 🟡 live test payment needs a Razorpay test account |
| Attendance | Rotating QR pass (screenshots expire), desk scan or manual check-in, one visit a day, history, daily report | ✅ tested |
| Dashboard & reports | KPIs; revenue, memberships, attendance, growth and renewals reports by day/week/month | ✅ tested |
| Reminders | Automatic renewal emails (09:00–20:00 gym time, retries); WhatsApp links for the desk | ✅ tested · sending 🟡 needs Resend |
| Privacy (DPDP) | Member data export (owner and member); erasure that keeps tax records anonymised | ✅ tested |
| API contract | OpenAPI 3.1 for all 101 operations, generated from the code (`docs/openapi.json`) | ✅ tested (CI fails if it goes stale) |

## How it was verified

- **398 tests** (38 test files) on a real MongoDB replica set, including concurrency tests: parallel
  payments, check-ins, sales, refunds and job runs each produce exactly the right result.
- **Isolation:** every gym collection is tested for cross-gym list, count, fetch, aggregate, join,
  update and delete. A new collection without isolation fails the tests.
- **Route audit:** a test reads every route and enforces sign-in, permissions, input validation,
  idempotency on money routes, and impersonation blocks. Only 16 routes are public, each on purpose (11 API routes, the OpenAPI document, and
  Swagger UI with its 3 assets, which is off in production).
- **Built-server smoke tests** after each milestone (M1–M9), plus an observed scheduled-job run.
- **Live:** Cloudinary on your account (7/7, including a tampered upload refused by Cloudinary).
- **Deployment rehearsal:** clean checkout, production build, production settings, simulated
  HTTPS proxy: 21 checks and a clean shutdown (DEPLOYMENT.md, "Verification").
- **Dependencies:** 0 known vulnerabilities; no secrets in the repository or its history.

Size: 116 source files (~12,500 lines), 38 test files plus 5 test helpers (~7,600 lines), 38 commits, 11 runtime
dependencies.

## Needs you

| # | Item | Why |
|---|---|---|
| 1 | **Resend** account, sending domain verified (SPF/DKIM/DMARC), API key in the server env | Members can't receive sign-in links or reminders without it |
| 2 | **Razorpay test account** (test keys + webhook secret) | One live test-mode payment to close online payments |
| 3 | **Hosting**: domain + Cloudflare, MongoDB Atlas (Mumbai) with backups, API host | To deploy; the steps are written and rehearsed (DEPLOYMENT.md) |
| 4 | Approve going live with real charges later (`RAZORPAY_ALLOW_LIVE`) | Project rule: no real charges without approval |
| 5 | Run the one-time index change on your local dev database | DATABASE.md, "Index migrations" |

## Decisions still open (yours, no rush)

1. Should front-desk staff see revenue on the dashboard? Built: owners only (one-line change).
2. Renewal rate counts late renewals as renewed and ignores memberships not yet ended. Built that way.

## Questions for your CA / lawyer

1. Does the PDF receipt also satisfy GST **tax invoice** requirements (fields, SAC code)?
2. After a DPDP erasure we keep payments and receipts anonymised as tax records. Confirm.
3. Old audit entries may still show a member's name until they expire (1 year). Acceptable?

## Known limits (by design for the pilot)

- One check-in per member per day; no grace days for expired members.
- Reports have no CSV/Excel export yet; the revenue report has no GST split (part payments make the
  split a CA decision).
- Reminder email is capped by Resend's free plan (100/day).
- Rate limit is 300 requests/min per IP, including Razorpay webhooks; revisit as online payments grow.
- Deferred major upgrades: TypeScript 7, pdfkit 0.20 (current versions are supported and patched).
- Full list: SECURITY.md, "Open findings".

## Phase 2 readiness

- The dashboard (`fitexaa-web`) can generate its API client from `docs/openapi.json`; behaviour per
  endpoint is in `docs/API.md`.
- Demo data (`npm run seed`): two gyms, owners, staff, members with memberships, payments and visits.
- Frontend notes already recorded: access token in memory only, refresh via HttpOnly cookie, email
  link page posts the token and clears it from the URL, permanent banner while "logged in as owner".

## Approval

Please reply with one of:
- **Approve Phase 1**: Phase 2 (dashboard) starts.
- **Changes needed**: list them; they'll be made and re-verified first.
