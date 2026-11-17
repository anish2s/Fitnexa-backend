# Development

## Prerequisites
- Node.js 22 (`.nvmrc`, `engines`), npm 10. Enforced: `.npmrc` sets `engine-strict=true`, so
  `npm install`/`npm ci` fail with `EBADENGINE` on an older Node. With nvm, either `nvm use` in the
  repo root (this shell only) or `nvm alias default 22` (every new shell). CI reads `.nvmrc`.
  Older Node also breaks Vitest's failure output (`Map.groupBy` needs Node 21+).
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
cp .env.example .env   # set MONGODB_URI and JWT_ACCESS_SECRET (openssl rand -base64 48)
npm run db:indexes
npm run seed           # 2 demo gyms + super admin; prints the demo password
npm run dev            # http://localhost:4000
```

### Trying tenant resolution locally
Browsers resolve `*.localhost` to 127.0.0.1, so gym subdomains work without editing `/etc/hosts`:
```bash
curl http://powerhouse.localhost:4000/api/v1/public/tenant
curl -H 'Host: fitzone.localhost' http://127.0.0.1:4000/api/v1/public/tenant
```
Sign in as the demo owner, then as a member by email link (the link appears in the API log):
```bash
curl -c jar -H 'Host: powerhouse.localhost' -H 'Content-Type: application/json' \
  -d '{"identifier":"owner@powerhouse.demo","password":"<seed password>"}' \
  http://127.0.0.1:4000/api/v1/auth/login
curl -H 'Host: powerhouse.localhost' -H 'Content-Type: application/json' \
  -d '{"email":"arjun@member.demo"}' http://127.0.0.1:4000/api/v1/auth/magic-link
```
The super admin signs in on `admin.localhost:4000`.

## Scripts
| Script | What it does |
|---|---|
| `npm run dev` | watch mode with tsx |
| `npm test` | all tests (unit, HTTP, DB integration) |
| `npm run typecheck` | `tsc --noEmit` over src + tests |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run build` / `npm start` | compile to `dist/` and run it |
| `npm run seed` | demo data (refuses in production, never overwrites) |
| `npm run admin:create -- --email … --name …` | create a super admin (`--reset` for a new password) |
| `npm run db:indexes` | create missing indexes (additive only) |

## Tests
- `tests/unit` — pure logic (host parsing, env, tenant plugin without a DB).
- `tests/http` — full Express pipeline via Supertest with a stubbed tenant lookup (no DB).
- `tests/integration/*.int.test.ts` — real MongoDB. Started by `tests/helpers/global-setup.ts`:
  - `MONGO_TEST_URI` set → uses it;
  - otherwise starts `mongodb-memory-server` (downloads MongoDB once, ~100 MB, cached);
    if the download is blocked, point it at an existing binary with `MONGOMS_SYSTEM_BINARY=/path/to/mongod`;
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
