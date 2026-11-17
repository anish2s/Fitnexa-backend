# Security

_Last updated: 2026-11-13 · Phase 1, Milestone 3_

All ✅ items are covered by automated tests that run against a real MongoDB 8.0 server.

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
| Real-DB proof: Gym B cannot list / get-by-id / update / delete / aggregate Gym A data | ✅ | `tests/integration/tenant-isolation.int.test.ts` |
| `runInTenant` / `runAsPlatform` finish lazy Mongoose queries inside the scope (bug found and fixed 2026-11-13) | ✅ | `tenancy/context.ts` |
| Duplicate-key errors never echo values (could belong to another gym) | ✅ (code) | `middleware/error-handler.ts` |
| Token tenant must equal host tenant (Gym A token rejected on Gym B) | ✅ | `middleware/authenticate.ts`, `tests/integration/auth.int.test.ts` |
| Gym credentials, email links, reset links and refresh cookies only work on their own gym's host | ✅ | same |
| Super admins: separate collection, authenticate only on the platform host; gym tokens rejected there | ✅ | same |
| CORS: a gym's origin may only call its own host (no cross-gym credentialed requests) | ✅ | `middleware/cors.ts`, `tests/http/app.test.ts` |
| Every new tenant model gets the cross-tenant suite | ⬜ M4+ | |

## Transport, headers, input

| Control | Status |
|---|---|
| helmet security headers; `x-powered-by` off | ✅ |
| CORS allow-list; wildcard entries match only the request's own host; look-alikes refused | ✅ |
| Rate limiting with standard 429 envelope: global per IP, plus per IP+gym and per IP+gym+account on auth endpoints | ✅ |
| JSON body limit 100 kb; malformed JSON → 400 | ✅ |
| `query parser: simple` (blocks `?a[$ne]=` operator injection), `strictQuery` | ✅ |
| Zod validation strips unknown keys (incl. any client `tenantId`) | ✅ |
| Request ids: client value accepted only if `[\w-]{8,64}` | ✅ |
| Logger redacts `authorization`, cookies, passwords, tokens, OTPs | ✅ |
| Config validated at startup; process refuses to boot misconfigured | ✅ |

## Authentication & sessions ✅ M2

| Control | Status |
|---|---|
| scrypt (N=2^15, r=8, p=1), 16-byte salt, timing-safe compare, NFKC-normalised, 128-char cap; parameters stored in the hash and upgraded on login | ✅ |
| Unknown account and wrong password: same status, code, message, and timing (dummy hash) | ✅ |
| Lockout after 5 failures (atomic counter), 15 min; reset clears it | ✅ |
| Access JWT: HS256 only (`alg` pinned), issuer + audience checked, 15 min, claims `sub sid typ tid role` | ✅ |
| Every request re-checks the session (logout is immediate) and loads role/permissions from the DB (demotion/disable is immediate) | ✅ |
| Refresh token: 256-bit random, stored only as SHA-256, rotated on every use, atomic rotation | ✅ |
| Replay of an old refresh token (after a 20 s tab-race grace) revokes the whole session | ✅ |
| Refresh cookie: `HttpOnly`, `SameSite=Lax`, host-only (`__Host-` prefix + `Secure` in production), never in a response body | ✅ |
| Cookie endpoints reject cross-origin / `Sec-Fetch-Site: cross-site` requests (CSRF between sibling gym subdomains) | ✅ |
| Member email links: 256-bit, hashed at rest, single use (atomic consume, concurrent clicks give one session), 15 min, max 3 per 15 min, gym-bound | ✅ |
| Link/forgot endpoints never reveal whether an email is registered | ✅ |
| Password reset / invite: single use, 30 min / 72 h, ends all sessions, kills other outstanding links | ✅ |
| Change password ends all other sessions | ✅ |
| Sessions list / revoke limited to the caller's own sessions (IDOR test) | ✅ |
| Super admin has no email reset; reset only via `admin:create --reset` on the server | ✅ |
| `Cache-Control: no-store` on every response carrying tokens or `/me` | ✅ |
| Production refuses to start with insecure cookies, a dev email transport, or http email links | ✅ |

Notes for the frontend (Phase 2/3):
- Keep the access token in memory only. Never `localStorage`.
- The email link puts the token in the URL. The `/login/verify` page must POST it immediately, then
  remove it from the address bar (`history.replaceState`), and send `Referrer-Policy: no-referrer`.
- Verification is a POST from the page, not a GET, so email link-preview scanners can't burn the link.

## Platform administration & audit ✅ M3

| Control | Status |
|---|---|
| `/platform/*` only for active super admins on the platform host; gym tokens refused; disabling an admin is immediate | ✅ |
| Owner endpoints (`/gym`) always act on the host's gym; ids, slug or status in the body are stripped (cross-tenant test) | ✅ |
| Gym + owner created in one transaction; owner starts `invited` with no password and sets it from an emailed link | ✅ |
| Slugs: format, no `--` (punycode look-alikes), reserved names, existing gyms incl. archived | ✅ |
| Suspension effective on the gym's next request (tenant re-read per request, no cache) | ✅ |
| Impersonation: reason required; audit entry written before the token is returned (if the write fails the session is revoked); token carries `imp`, works on that gym only, can't be refreshed, ends with the access token (15 min) or on `impersonation/end`; re-checks the admin is active on every request | ✅ |
| While impersonating: no password change, logout-all or session revoke | ✅ |
| Every impersonated action logged with both actor and impersonator; owner can read their gym's log | ✅ |
| Audit log append-only at the model layer; personal values (email, phone) masked in `changes` | ✅ |
| Audit writes for ordinary actions don't fail the request; a failed write is logged with the full entry | ✅ (code) |
| Search input escaped before use in a RegExp | ✅ |
| Audit entries expire after 1 year (TTL index on both audit collections) | ✅ |
| Staff endpoints pin path ids to `role: staff` in the host gym: owners/members can't be edited through them (IDOR test) | ✅ |
| Staff grants limited to `STAFF_GRANTABLE`; `staff:manage`, gym settings, branding, audit never grantable | ✅ |
| Deactivating staff ends all their sessions and blocks the next request | ✅ |
| Members: path ids resolved inside the host gym only (cross-tenant test); members reach only `/members/me`, never a record by id (IDOR test) | ✅ |
| Member creation + login + code counter in one transaction: a duplicate leaves nothing half-created | ✅ |
| Archiving a member or removing their email ends their sessions immediately | ✅ |
| DPDP consent captured at registration with time, wording version and recorder | ✅ |
| Staff notes never returned to the member | ✅ |
| Audit log masks member names, birth dates, notes, emergency contacts, email, phone | ✅ |

## Email ✅ (transport) · 🟡 (live delivery)

| Control | Status |
|---|---|
| Resend API key only from env; startup refuses `resend` without a key or with a localhost sender | ✅ |
| Provider failures never change the response of magic-link / forgot-password (no account enumeration via 500s) | ✅ |
| Logs carry email kind and provider id only, never recipient, link or provider error text | ✅ |
| 10 s timeout; no automatic retry (a retry could double-send a one-time link) | ✅ |
| Real delivery through Resend with a verified domain | 🟡 blocked: needs API key + verified domain |

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
- Collect the minimum: DOB/gender optional; no ID documents stored. ✅ M4
- Consent recorded with timestamp and version at registration. ✅ M4
- Export (JSON) and erase (anonymise financial records, delete photo) endpoints for owners.
- PII never in URLs; PWA never caches authenticated API responses (Phase 3).

## Open findings
1. Rate limiter is in-memory per instance: fine for the single-instance pilot; revisit if scaling out.
2. Tenant lookup runs on every request (indexed). Add a small TTL cache if profiling shows need; cache
   must be invalidated on suspend.
3. `npm audit`: 0 vulnerabilities in runtime dependencies; 10 moderate in dev-only ESLint tooling
   (not shipped). Re-check on each dependency update.
4. Every authenticated request costs two indexed reads (session + user). Fine at pilot scale; a
   short in-process cache is the first optimisation if needed.
5. In development, the `log` email transport prints sign-in links to the API log. Production refuses
   this transport.
6. Members without an email address cannot use the member app. Front desk must collect an email at
   registration (Milestone 4 will make this visible in the member form).
7. ~~Audit log retention~~ Decided 2026-11-17: one year, enforced by a TTL index (tested).
8. **Accepted risk** (owner, 2026-11-17): the audit log is append-only in application code only; the
   MongoDB user can still modify it. No separate DB role for now.
9. Resend free plan caps mail at 100/day. A burst of sign-in links past that is refused until the
   next day; members would see no email. Monitor `Email could not be sent` in the logs; upgrade the
   plan before onboarding more than a few gyms.
