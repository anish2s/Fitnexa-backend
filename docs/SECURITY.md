# Security

_Last updated: 2026-11-17 · Phase 1, Milestone 5_

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
| Aggregate joins (`$lookup`, `$unionWith`, `$graphLookup`, also inside `$facet` and nested lookups) get the tenant filter injected; joining an unscoped collection yields nothing (fail closed). Gap found and fixed in M5, before any join existed | ✅ | `tenancy/tenant-scope.plugin.ts`, `tests/integration/tenant-isolation.int.test.ts` |
| Isolation violations logged as fatal, returned as opaque 500 | ✅ | `middleware/error-handler.ts` |
| Real-DB proof: Gym B cannot list / get-by-id / update / delete / aggregate Gym A data | ✅ | `tests/integration/tenant-isolation.int.test.ts` |
| `runInTenant` / `runAsPlatform` finish lazy Mongoose queries inside the scope (bug found and fixed 2026-11-13) | ✅ | `tenancy/context.ts` |
| Duplicate-key errors never echo values (could belong to another gym) | ✅ (code) | `middleware/error-handler.ts` |
| Token tenant must equal host tenant (Gym A token rejected on Gym B) | ✅ | `middleware/authenticate.ts`, `tests/integration/auth.int.test.ts` |
| Gym credentials, email links, reset links and refresh cookies only work on their own gym's host | ✅ | same |
| Super admins: separate collection, authenticate only on the platform host; gym tokens rejected there | ✅ | same |
| CORS: a gym's origin may only call its own host (no cross-gym credentialed requests) | ✅ | `middleware/cors.ts`, `tests/http/app.test.ts` |
| Every model is classified scoped/platform; scoped models proven isolated for list, count, fetch, aggregate, update, delete (a new unclassified model fails CI) | ✅ | `tests/integration/all-models-isolation.int.test.ts` |
| Every index on a scoped model starts with `tenantId` (TTL indexes excepted) | ✅ | same |

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
| Uploads: the server picks the image path (gym folder + member + random name) and the signature binds it, so clients can't write into another gym's or member's space; `overwrite=false`; jpg/png/webp only | ✅ (confirmed against Cloudinary) |
| Photo confirmation accepts only ids under this gym + member prefix with the issued name shape (no traversal) | ✅ |
| Cloudinary secret never returned; image bytes never pass through the API | ✅ |
| Live upload against Cloudinary: signature binds the path (tampered path refused by Cloudinary), no overwrite, delete works | ✅ verified live 2026-11-17 |
| Memberships: no overlapping periods, enforced in a transaction that serialises sales per member (6 parallel sales → 1 created) | ✅ |
| Price/tax snapshot at sale; amounts computed server-side from the plan, never taken from the client | ✅ |
| Payments: required Idempotency-Key, unique per gym; retries replay, key reuse for another payment refused; concurrent duplicates collapse to one | ✅ |
| No overpayment at the desk: atomic `$expr` guard in the same transaction as the payment (parallel test) | ✅ |
| Payment row, membership balance and receipt counter commit together or not at all; receipts gap-free | ✅ |
| Refunds: owner-only by default (`payments:refund`), idempotent, can never exceed the payment (parallel test), audited with reason | ✅ |
| Reports owner-only by default (`reports:read`); dashboard revenue hidden from staff without it; ranges capped at 366 days | ✅ |
| CSV import: 1 MB / 2,000-row cap, parsed in memory without eval, same validation as the form, all-or-nothing transaction, needs `members:import` | ✅ |

## Email ✅ (transport) · 🟡 (live delivery)

| Control | Status |
|---|---|
| Resend API key only from env; startup refuses `resend` without a key or with a localhost sender | ✅ |
| Provider failures never change the response of magic-link / forgot-password (no account enumeration via 500s) | ✅ |
| Logs carry email kind and provider id only, never recipient, link or provider error text | ✅ |
| 10 s timeout; no automatic retry (a retry could double-send a one-time link) | ✅ |
| Real delivery through Resend with a verified domain | 🟡 blocked: needs API key + verified domain |

## Payments ✅ M6

| Control | Status |
|---|---|
| Razorpay webhooks: HMAC-SHA256 over the **raw** body bytes (captured before JSON parsing), timing-safe compare, per-gym secret, event id de-duplicated (30-day TTL) | ✅ |
| Checkout callbacks never mark anything paid without server-side signature verification (HMAC of `order_id|payment_id` with the gym's key secret); forged/swapped signatures record nothing | ✅ |
| Amount of an online payment comes from our order (or the signed webhook), never from the client | ✅ |
| Each gateway payment id recorded once (unique index); verify + webhook racing for the same payment → one row | ✅ |
| `Idempotency-Key` required on every money-recording request; unique per gym | ✅ |
| Payment + membership balance + receipt counter in one transaction; receipts and refund numbers gap-free per FY | ✅ |
| Gym Razorpay secrets: AES-256-GCM, master key from env, gym id as AAD (a secret copied to another gym won't open), `select: false`, never returned or logged | ✅ |
| Live keys refused unless `RAZORPAY_ALLOW_LIVE=true` (owner approval, project Rule 7) | ✅ |
| Payout keys: owner only, not while a super admin is impersonating | ✅ |
| Gateway refunds reserved in our books before calling Razorpay; reverted on refusal or `refund.failed` (idempotent) | ✅ |
| Members can only create orders for, and complete, their own memberships (IDOR tests) | ✅ |
| Tests can't reach Razorpay: the test app's default client throws; a fake is injected where needed | ✅ |
| Live Razorpay round trip (test keys) | 🟡 needs a Razorpay test account |

## Attendance QR ✅ M7

| Control | Status |
|---|---|
| Pass = `gp1.<memberId>.<window>.<sig>`, sig = HMAC-SHA256 (truncated 128 bit) with a **per-gym key** (HKDF of the server secret, salt = gym id): a pass from one gym fails at another | ✅ |
| 30 s windows; scanner accepts 2 back / 1 ahead (≈60–90 s): screenshots expire; moving the window breaks the signature | ✅ |
| Signature checked before the time window, constant-time compare | ✅ |
| One check-in per member per gym day (unique index); parallel scans → one row; replays inside the window are no-ops | ✅ |
| Admission needs an active membership today (gym time zone); archived members refused | ✅ |
| Only staff (`attendance:checkin`) can check in; members can't check themselves in | ✅ |
| `QR_SIGNING_SECRET` optional; default is derived from `JWT_ACCESS_SECRET` with domain separation (never the JWT key itself) | ✅ |

## Scheduled jobs & reminders ✅ M9

| Control | Status |
|---|---|
| Jobs run per gym inside `runInTenant`; suspended/archived gyms skipped; one gym's failure isolated | ✅ |
| Lease lock: concurrent instances run a job once (5 parallel → 1) | ✅ |
| Reminders claimed atomically (queued → sending) so no double send; stuck sends re-queued after 15 min (a crash mid-send could repeat one email) | ✅ |
| Queue stores no address or text; conditions re-checked at send time (renewed/archived/no email) | ✅ |
| No email to members outside 09:00–20:00 gym time; owner can switch reminders off | ✅ |

## Privacy (DPDP Act 2023) ✅ M9

| Control | Status |
|---|---|
| Collect the minimum: DOB/gender optional; no ID documents stored | ✅ M4 |
| Consent recorded with timestamp, wording version and recorder at registration | ✅ M4 |
| Right of access: owner export of everything held about a member; member self-export (without staff-internal notes); both audited | ✅ |
| Right to erasure: personal fields, photo (deleted from storage), login, sessions, sign-in links and reminders removed in one transaction; financial and attendance records kept anonymised | ✅ |
| Erase is owner-only (`privacy:manage`, not grantable), blocked while impersonated, needs the member code typed back; irreversible (no restore, no edits) | ✅ |
| Erase audit entry holds only member code and reason | ✅ |
| Personal values masked in audit `changes`; reminder queue stores no address or text | ✅ |
| PII never in URLs; PWA never caches authenticated API responses | ⬜ Phase 3 |

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
   registration. The member API reports `appAccess.reason: "no_email"` so the form can flag it (M4).
7. ~~Audit log retention~~ Decided 2026-11-17: one year, enforced by a TTL index (tested).
8. **Accepted risk** (owner, 2026-11-17): the audit log is append-only in application code only; the
   MongoDB user can still modify it. No separate DB role for now.
9. Resend free plan caps mail at 100/day. A burst of sign-in links past that is refused until the
   next day; members would see no email. Monitor `Email could not be sent` in the logs; upgrade the
   plan before onboarding more than a few gyms.
10. Uploads: file size isn't capped by the signature (Cloudinary's free plan caps images at 10 MB).
    If needed, add an upload preset with a size limit. A client could also confirm a signed id it
    never uploaded; the result is just a broken image for that member, inside that gym.
11. Receipts are "payment receipts". Whether they also meet GST **tax invoice** requirements (fields,
    SAC code, numbering rules, B2B details) must be confirmed by the gym's CA before relying on them
    for GST filing. Changing the layout is cheap; tell us what the CA asks for.
12. Rotating `PAYMENTS_ENCRYPTION_KEY` makes stored gym secrets unreadable (gyms re-enter keys; the
    API treats undecryptable secrets as "not connected" and logs an error). A key-rotation script can
    be added if it becomes routine.
13. Razorpay orders are created for the balance at that moment. If the desk collects cash before the
    member completes online payment, both are recorded and the membership shows `overpaid`; the owner
    refunds the excess. Auto-refund was not built (money decisions stay with the owner).
14. A pass shared within its ~60–90 s life could let a friend in if the member hasn't checked in that
    day yet. The desk sees the member's photo on every scan to catch this; adding photos (Cloudinary)
    makes the check real.
15. **Erasure and retained records (CA/lawyer to confirm):** payments, refunds and receipts are kept
    (anonymised) because Indian tax law requires keeping financial records for years. Audit entries
    written before an erasure may still contain the member's *name* as an actor (e.g. a self-service
    update); they expire with the audit log's 1-year retention. The member's own export leaves out
    staff notes; the owner's export includes them, so the gym can answer a formal access request.
