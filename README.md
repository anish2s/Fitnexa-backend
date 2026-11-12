# Gym SaaS

Multi-tenant, white-label gym management platform. One app, one database, many gyms
(`powerhouse.yourapp.in`, `fitzone.yourapp.in`, …) with strict per-gym data isolation.

| App | Path | Status |
|---|---|---|
| Backend API (Express + MongoDB) | `apps/api` | Phase 1 in progress |
| Admin dashboard (Next.js) | `apps/dashboard` | Phase 2 — not started |
| Member PWA (Next.js) | `apps/member` | Phase 3 — not started |

```bash
npm install
cp apps/api/.env.example apps/api/.env
npm run dev:api
npm test
```

Docs: [architecture](docs/ARCHITECTURE.md) · [database](docs/DATABASE.md) · [security](docs/SECURITY.md) ·
[API](docs/API.md) · [development](docs/DEVELOPMENT.md) · [deployment](docs/DEPLOYMENT.md) ·
[progress](docs/PROGRESS.md) · [design direction](docs/DESIGN.md)
