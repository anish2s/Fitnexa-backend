# gym-saas-api

Backend API for a multi-tenant, white-label gym management platform. One API, one database,
many gyms (`powerhouse.yourapp.in`, `fitzone.yourapp.in`, …) with strict per-gym data isolation.

The admin dashboard and member PWA live in a separate repository, **gym-saas-web**, and talk to
this API only through its documented REST endpoints.

**Status:** Phase 1 (backend) in progress. See [progress](docs/PROGRESS.md).

```bash
npm install
cp .env.example .env    # set MONGODB_URI
npm run dev             # http://localhost:4000
npm test
```

Docs: [architecture](docs/ARCHITECTURE.md) · [database](docs/DATABASE.md) · [security](docs/SECURITY.md) ·
[API](docs/API.md) · [development](docs/DEVELOPMENT.md) · [deployment](docs/DEPLOYMENT.md) ·
[progress](docs/PROGRESS.md)
