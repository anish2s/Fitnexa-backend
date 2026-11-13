# Development

## Prerequisites
- Node.js 22 (`.nvmrc`), npm 10
- MongoDB for running the API locally: either MongoDB Atlas (free M0) or a local `mongod` started as a
  single-node replica set (needed later for transactions):
  ```bash
  mongod --replSet rs0 --dbpath ./.mongo-data
  mongosh --eval 'rs.initiate()'
  ```
- Tests need **no** manual MongoDB: they download and start an in-memory replica set automatically.

## Setup
```bash
npm install
cp .env.example .env   # then edit MONGODB_URI
npm run dev            # http://localhost:4000
```

### Trying tenant resolution locally
Browsers resolve `*.localhost` to 127.0.0.1, so gym subdomains work without editing `/etc/hosts`:
```bash
curl http://powerhouse.localhost:4000/api/v1/public/tenant
curl -H 'Host: fitzone.localhost' http://127.0.0.1:4000/api/v1/public/tenant
```
(Seed data arrives in Milestone 2; until then insert a tenant with `mongosh`.)

## Scripts
| Script | What it does |
|---|---|
| `npm run dev` | watch mode with tsx |
| `npm test` | all tests (unit, HTTP, DB integration) |
| `npm run typecheck` | `tsc --noEmit` over src + tests |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run build` / `npm start` | compile to `dist/` and run it |

## Tests
- `tests/unit` — pure logic (host parsing, env, tenant plugin without a DB).
- `tests/http` — full Express pipeline via Supertest with a stubbed tenant lookup (no DB).
- `tests/integration/*.int.test.ts` — real MongoDB. Started by `tests/helpers/global-setup.ts`:
  - `MONGO_TEST_URI` set → uses it;
  - otherwise starts `mongodb-memory-server` (downloads MongoDB once, ~100 MB, cached);
  - if neither works, DB suites are **skipped with a warning**. Set `REQUIRE_DB=1` (always in CI) to
    make that a failure instead.

## Conventions
- Feature module layout: `*.routes.ts`, `*.controller.ts`, `*.service.ts`, `*.model.ts`, `*.schemas.ts`.
- Every tenant-owned schema: `schema.plugin(tenantScopePlugin)` and compound indexes starting with `tenantId`.
- Never pass `tenantId` from request data into a query. The context does it.
- Cross-tenant work only inside `runAsPlatform('reason', fn)`.
- Money in paise (integers). Dates stored UTC; "day" logic uses the gym's timezone.
- Throw `Errors.*` / `AppError` for expected failures; let the error handler format responses.
- New endpoint ⇒ Zod schemas + tests (happy path, validation, authorization, cross-tenant).
