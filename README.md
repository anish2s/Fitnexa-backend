# fitexaa-backend

Backend API for **Fitexaa**, a multi-tenant, white-label gym management platform. One API, one database,
many gyms (`powerhouse.yourapp.in`, `fitzone.yourapp.in`, …) with strict per-gym data isolation.

The admin dashboard and member PWA live in a separate repository, **fitexaa-web**, and talk to
this API only through its documented REST endpoints.

**Status:** Phase 1 (backend) complete: 398 tests against a real MongoDB; see the
[Phase 1 report](docs/PHASE1-REPORT.md) (awaiting approval) and [progress](docs/PROGRESS.md).
API contract: [`docs/openapi.json`](docs/openapi.json) (OpenAPI 3.1).

What's in it: per-gym isolation by subdomain, owner/staff/member auth, super-admin console with
audited "log in as owner", staff and members (CSV import, photos), plans with GST, memberships and
renewals, desk payments with receipts and refunds, Razorpay (test mode), QR attendance, dashboard and
reports, renewal reminders, WhatsApp links, DPDP export/erase.

```bash
npm install
cp .env.example .env    # set MONGODB_URI
npm run dev             # http://localhost:4000
npm test
```

Docs: [architecture](docs/ARCHITECTURE.md) · [database](docs/DATABASE.md) · [security](docs/SECURITY.md) ·
[API](docs/API.md) · [development](docs/DEVELOPMENT.md) · [deployment](docs/DEPLOYMENT.md) ·
[progress](docs/PROGRESS.md)
