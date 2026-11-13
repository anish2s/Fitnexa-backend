# CLAUDE.md — gym-saas-api

Backend for a multi-tenant, white-label Gym Management SaaS (India first). One API, one MongoDB,
many gyms on their own subdomains (`powerhouse.yourapp.in`). Frontends live in a separate repo,
`gym-saas-web`, and use this API only over REST.

**Read `docs/PROGRESS.md` first** — it is the source of truth for what is done and what is next.
Architecture: `docs/ARCHITECTURE.md`. Security controls: `docs/SECURITY.md`. Schema: `docs/DATABASE.md`.

## Your role and the rules (from the owner's brief)

Act as the senior engineer who owns the outcome: inspect, plan, implement, test, fix, document.

1. **Phases are gated.** Phase 1 = this backend. Do NOT start the dashboard (Phase 2) or member PWA
   (Phase 3) until the owner approves the Phase 1 completion report.
2. **Small verified milestones.** For each milestone: objective → plan → implement → run tests → fix →
   update docs → report. One commit per meaningful step.
3. **Never claim untested work.** Report each item as: tested & passed / implemented-not-verified / blocked.
4. **Keep docs current** (`docs/*.md`) whenever behaviour changes. Tick boxes in `docs/PROGRESS.md`
   only when verified.
5. **Don't overengineer.** No Redis, queues, microservices or Kubernetes without a concrete need.
6. **Security first.** Tenant isolation, auth, validation, payment/webhook verification, privacy (DPDP Act).
7. **No production actions** (deploys, real emails/SMS/WhatsApp, real charges, production data)
   without explicit approval. Missing credentials → build a safe interface + document the config.
8. **No destructive changes** (dropping data, deleting files, force-push, rewriting history) without approval.
9. Ask the owner **one focused question** only when a business decision is genuinely ambiguous.

## Commands

```bash
npm install
npm run dev            # tsx watch, reads .env
npm test               # all tests (unit, HTTP, real-MongoDB integration)
npm run typecheck && npm run lint && npm run build
npm run seed           # demo gyms: powerhouse, fitzone (+ super admin); prints password
npm run db:indexes     # additive index creation
npm run admin:create -- --email x@y --name "Name"
```

Before every commit: `npm run typecheck && npm run lint && REQUIRE_DB=1 npm test` must all pass.
`REQUIRE_DB=1` makes a missing MongoDB fail instead of silently skipping the isolation tests.
If the MongoDB download is blocked, set `MONGOMS_SYSTEM_BINARY=/path/to/mongod` (or `MONGO_TEST_URI`).

## Architecture you must preserve

- **Tenant comes from the host only** (`src/tenancy/resolver.middleware.ts`). Never read a gym id
  from body, query or params. Zod schemas never declare `tenantId`.
- **Every tenant-owned schema** uses `schema.plugin(tenantScopePlugin)` and indexes that start
  with `tenantId`. The plugin forces `tenantId` into every query and **throws** with no context.
- Outside a request (jobs, scripts) use `await runInTenant(gymId, fn)` or
  `await runAsPlatform('reason', fn)`. Both await inside the scope (lazy Mongoose queries).
- **Auth** (`src/middleware/authenticate.ts`): access token gym must equal host gym; session and
  role are re-read from the DB each request. Protect routes with `authenticate` + `authorize('perm')`
  using permissions from `src/auth/permissions.ts`, never role-name checks.
- Super admins: `platformAdmins` collection, platform host only, `requirePlatformAdmin`.
- Members sign in by one-time **email link** (owner's decision); owners/staff by password.
- Responses: `ok()/created()/noContent()` from `src/lib/response.ts`; errors: throw `Errors.*` /
  `AppError` (`src/lib/errors.ts`). Never `res.status(500)` by hand.
- Money in **integer paise**. Dates stored UTC; "today" uses the gym's `settings.timezone`.
- Email goes through the `Mailer` interface (`src/lib/mailer.ts`); no real sending yet.

## Module layout (follow it for new features)

`src/modules/<feature>/` → `*.routes.ts` (wiring + middleware) · `*.controller.ts` (HTTP only) ·
`*.service.ts` (business rules) · `*.model.ts` (Mongoose) · `*.schemas.ts` (Zod).
Register new models in `src/db/models.ts`. Mount routes in `src/app.ts` under `/api/v1`.

## Tests required for every new endpoint

Happy path · validation (422) · authorization (401/403 per role) · **cross-tenant attempt from the
other demo gym must fail** · IDOR (another user's id in the same gym) where relevant.
Integration tests use the real demo seed (`seedDemo`) — see `tests/integration/auth.int.test.ts`.

## Style

TypeScript strict, ESM (`.js` import suffixes), Prettier (single quotes, width 100), no `console`
(use `req.log` / logger). Comments explain *why*, not what.

## Git

Commit messages: imperative subject, body explaining what and why. Don't push or open PRs unless asked.
