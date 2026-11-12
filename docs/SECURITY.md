# Security

_Last updated: 2026-11-12 · Phase 1, Milestone 1_

Status legend: ✅ implemented & tested · 🟡 implemented, not yet verified · ⬜ planned (milestone)

## Tenant isolation (the #1 risk)

| Control | Status | Where |
|---|---|---|
| Tenant resolved from host only; body/query/params never consulted | ✅ | `tenancy/resolver.middleware.ts` |
| Nested subdomains, look-alike domains, malformed hosts rejected | ✅ | `tenancy/host.ts`, `tests/unit/host.test.ts` |
| `X-Forwarded-Host` ignored unless `TRUST_PROXY` set | ✅ | `app.ts`, `tests/http/app.test.ts` |
| Dev header fallback (`X-Tenant-Slug`) impossible in production | ✅ | `config/env.ts` (startup refuses) |
| Request-scoped tenant context survives async work; concurrent gyms don't mix | ✅ | `tests/http/resolver-context.test.ts` (40 interleaved requests) |
| `tenantId` forced into every query, aggregate, insert | ✅ | `tenancy/tenant-scope.plugin.ts`, `tests/unit/tenant-scope.plugin.test.ts` |
| Fail closed: no context → operation throws | ✅ | same |
| Filters/inserts naming another tenant throw; updates can't change `tenantId` | ✅ | same |
| Unscopeable ops (`estimatedDocumentCount`, `bulkWrite`) blocked in tenant scope | ✅ | same |
| Isolation violations logged as fatal, returned as opaque 500 | ✅ | `middleware/error-handler.ts` |
| Real-DB proof: Gym B cannot list / get-by-id / update / delete / aggregate Gym A data | 🟡 | `tests/integration/tenant-isolation.int.test.ts` — written, skipped in the build sandbox (no MongoDB), must pass on a machine with MongoDB |
| Duplicate-key errors never echo values (could belong to another gym) | ✅ (code) | `middleware/error-handler.ts` |
| Token tenant must equal host tenant | ⬜ M2 | |
| Super admins authenticate only on the platform host | ⬜ M2 | |
| Every new tenant model gets the cross-tenant suite | ⬜ M4+ | |

## Transport, headers, input

| Control | Status |
|---|---|
| helmet security headers; `x-powered-by` off | ✅ |
| CORS allow-list with safe wildcard (`https://*.yourapp.in`), look-alikes refused | ✅ |
| Rate limiting with standard 429 envelope | ✅ (per-IP global) · ⬜ per-identifier login limits M2 |
| JSON body limit 100 kb; malformed JSON → 400 | ✅ |
| `query parser: simple` (blocks `?a[$ne]=` operator injection), `strictQuery` | ✅ |
| Zod validation strips unknown keys (incl. any client `tenantId`) | ✅ (middleware) · used by routes from M2 |
| Request ids: client value accepted only if `[\w-]{8,64}` | ✅ |
| Logger redacts `authorization`, cookies, passwords, tokens, OTPs | ✅ |
| Config validated at startup; process refuses to boot misconfigured | ✅ |

## Authentication & sessions ⬜ M2
- Passwords hashed with scrypt (N=2^15) + per-password salt; constant-time compare.
- Access JWT 15 min (HS256, `tid`, `sub`, `role`, `sid`); refresh token random 256-bit, stored only as
  SHA-256 hash, rotated on every use, family revoked on reuse.
- Refresh cookie: host-only, `HttpOnly`, `Secure`, `SameSite=Lax`, path `/api/v1/auth`.
- Login responses identical for "no such user" and "wrong password"; per-account lockout and
  per-IP+identifier rate limits.
- Password reset: single-use hashed tokens, 30-min TTL, all sessions revoked on reset.
- Tokens issued before `passwordChangedAt` rejected.

## Payments ⬜ M6
- Razorpay webhooks: HMAC-SHA256 over the **raw** body, timing-safe compare, event id de-duplicated.
- Client "payment success" callbacks never mark anything paid without server-side signature verification.
- `Idempotency-Key` on payment creation; unique indexes on gateway ids.
- Payment + membership + receipt counter written in one transaction.
- Gym Razorpay secrets encrypted at rest (AES-256-GCM, key from env).

## Attendance QR ⬜ M7
- Member pass = `HMAC(tenantId|memberId|window)` with 30–60 s rotating windows; server accepts current ±1
  window; a token is single-use per day. Screenshots expire.

## Privacy (DPDP Act 2023) ⬜ M9
- Collect the minimum: DOB/gender optional; no ID documents stored.
- Consent recorded with timestamp and version at registration.
- Export (JSON) and erase (anonymise financial records, delete photo) endpoints for owners.
- PII never in URLs; PWA never caches authenticated API responses (Phase 3).

## Open findings
1. Rate limiter is in-memory per instance: fine for the single-instance pilot; revisit if scaling out.
2. Tenant lookup runs on every request (indexed). Add a small TTL cache if profiling shows need; cache
   must be invalidated on suspend.
3. `npm audit`: 0 vulnerabilities in runtime dependencies; 10 moderate in dev-only ESLint tooling
   (not shipped). Re-check on each dependency update.
