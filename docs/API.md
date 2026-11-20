# API

**Machine-readable contract:** `GET /api/v1/openapi.json` (OpenAPI 3.1, also committed as
[`docs/openapi.json`](openapi.json)). Generated from the mounted routers and their Zod schemas, so every
route, path/query/header parameter, request body, sign-in requirement and permission in it is the
real one; CI fails if the committed file is stale (`npm run openapi` regenerates it). Responses are
described as the standard envelope; the `data` of each endpoint is documented below.
Swagger UI: `/api/docs`, served from this server (no CDN). Off in production unless
`ENABLE_API_DOCS=true`. `/api/v1/openapi.json` is always public.

Base path: `/api/v1`. The gym is identified by the host (`<gym>.yourapp.in`).

## Envelope
```jsonc
// success
{ "success": true, "data": { ... }, "meta": { "page": 1, "limit": 20, "total": 134, "totalPages": 7 } }
// error
{ "success": false, "error": { "code": "TENANT_NOT_FOUND", "message": "Gym not found", "details": [...], "requestId": "…" } }
```
Every response carries `X-Request-Id`.

## Error codes
| HTTP | code | When |
|---|---|---|
| 400 | `BAD_REQUEST`, `INVALID_JSON`, `TENANT_REQUIRED` | malformed input; tenant endpoint called on a platform host |
| 400 | `INVALID_LINK` | email link unknown, used, expired, or from another gym |
| 401 | `UNAUTHORIZED` | missing/invalid token, token from another gym or host, session ended |
| 401 | `TOKEN_EXPIRED` | access token expired → call `/auth/refresh` |
| 401 | `INVALID_CREDENTIALS` | wrong password **or** unknown account (indistinguishable) |
| 401 | `INVALID_REFRESH`, `REFRESH_RACE` | refresh cookie dead (sign in again) / another tab refreshed first (retry) |
| 403 | `FORBIDDEN`, `TENANT_SUSPENDED`, `ACCOUNT_DISABLED`, `CROSS_ORIGIN_REJECTED` | |
| 403 | `WRONG_SITE` | staff on the member app's address or a member on the staff dashboard's (only when `STAFF_BASE_DOMAINS` is set; see "Member and staff addresses") |
| 404 | `NOT_FOUND`, `ROUTE_NOT_FOUND`, `TENANT_NOT_FOUND` | unknown and archived gyms are indistinguishable |
| 409 | `CONFLICT`, `DUPLICATE` | duplicate values are never echoed back |
| 413 | `PAYLOAD_TOO_LARGE` | body > 100 kb |
| 503 | `UPLOADS_NOT_CONFIGURED` | Cloudinary credentials not set |
| 503 | `PAYMENT_GATEWAY_NOT_CONFIGURED` | server has no `PAYMENTS_ENCRYPTION_KEY` |
| 409 | `PAYMENT_GATEWAY_NOT_CONNECTED` | this gym hasn't connected Razorpay |
| 502 | `PAYMENT_GATEWAY_ERROR` | Razorpay refused or couldn't be reached |
| 400 | `INVALID_SIGNATURE` | checkout or webhook signature didn't verify |
| 400 | `PASS_INVALID`, `PASS_EXPIRED` | attendance QR not for this gym / too old |
| 409 | `NO_ACTIVE_MEMBERSHIP` | check-in without a membership active today |
| 422 | `VALIDATION_ERROR` | `details: [{ path, message }]` |
| 422 | `IMPORT_INVALID` | CSV import had bad rows; `details` = row report; nothing written |
| 429 | `RATE_LIMITED`, `LOGIN_LOCKED` | |
| 500 | `INTERNAL_ERROR` | no internals exposed |

## Endpoints

### `GET /health` — liveness
`200 { status: "ok", uptimeSec }`

### `GET /ready` — readiness
`200 { status: "ready", checks: { database: "up" } }` or `503` with `database: "down"`.

### `GET /api/v1/public/tenant` — gym branding (no auth)
Called by the dashboard and PWA before login. Gym host required.
```json
{
  "success": true,
  "data": {
    "name": "Powerhouse Fitness",
    "slug": "powerhouse",
    "status": "active",
    "site": "member",
    "branding": {
      "logoUrl": "https://…",
      "appIconUrl": null,
      "coverImageUrl": null,
      "primaryColor": "#E11D48",
      "secondaryColor": "#0F172A",
      "defaultTheme": "dark",
      "updatedAt": "2026-11-19T10:00:00.000Z"
    },
    "contact": { "phone": "+919800000001", "address": "2nd floor, MG Road, Camp", "city": "Pune" }
  }
}
```
`site` is `member`, `staff` or `any` (see "Member and staff addresses"). `contact` is the gym's own
business phone and address (`address` = line 1 and line 2 joined with ", "; each `null` when unset);
nothing else about the gym is public.
`status` is `active` or `suspended` (suspended gyms still show branding so the login page can explain).
`branding.updatedAt` is the last branding change (`null` until the first); clients version icon and
logo URLs with it so a change shows at once. Cached for 60 s.

## Member and staff addresses (Phase 3)

Members use the gym's main address (`powerhouse.yourapp.in`, the member app); owners and staff use a
separate staff address (`powerhouse.<staff base>`, the dashboard). Configure with `STAFF_BASE_DOMAINS`
(e.g. `staff.yourapp.in`; locally `staff.localhost`). The longest matching base domain wins, so
`powerhouse.staff.localhost` is the staff site of the gym `powerhouse`. Each gym request has a site:

| Site | When | Allowed |
|---|---|---|
| `member` | under `BASE_DOMAINS` (or a custom domain) while `STAFF_BASE_DOMAINS` is set | member sessions; `POST /auth/magic-link`, `/magic-link/verify` |
| `staff` | under `STAFF_BASE_DOMAINS` | owner/staff sessions (incl. "log in as owner"); `POST /auth/login`, `/password/forgot`, `/password/reset` |
| `any` | `STAFF_BASE_DOMAINS` empty | everything (the behaviour before Phase 3) |

Anything else answers `403 WRONG_SITE` ("Staff sign in on the staff dashboard." on a member site,
"Members sign in on the gym's member app." on a staff site): the sign-in endpoints above, any request
with a token of the other kind, `POST /auth/refresh` (checked before the token is rotated, so the
session is untouched) and `GET /auth/session`. Owner/staff emails (password reset, invites) link to
`STAFF_APP_URL_TEMPLATE` (default `GYM_APP_URL_TEMPLATE`); member links (sign-in, WhatsApp, renewal
reminders) to `GYM_APP_URL_TEMPLATE`.

## Authentication — `/api/v1/auth`

Who signs in where:

| Who | Host | Method |
|---|---|---|
| Gym owner, staff | `<gym>.yourapp.in` | email **or** phone + password |
| Member | `<gym>.yourapp.in` | one-time email link (no password) |
| Super admin | platform host (`admin.yourapp.in`) | email + password |

**Tokens.** Successful sign-in returns a 15-minute `accessToken` in the body (keep it in memory;
send as `Authorization: Bearer …`). The refresh token is set as an `HttpOnly` cookie
(`__Host-gym_rt` in production, `gym_rt` in development) and is never readable by page scripts.
When a call returns `TOKEN_EXPIRED`, call `POST /auth/refresh` once and retry. Run only one refresh
at a time per tab group; a parallel second refresh gets `REFRESH_RACE` and should simply retry.

A token only works on the host it was issued for: a Powerhouse token is rejected on FitZone and on the
platform host.

### Session response (login, magic-link/verify, refresh)
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJ…",
    "tokenType": "Bearer",
    "expiresIn": 900,
    "user": {
      "id": "…", "name": "Rahul Mehta", "email": "owner@powerhouse.demo", "phone": "+919800000001",
      "role": "owner", "status": "active",
      "permissions": ["members:read", "payments:record", "reports:read", "…"]
    }
  }
}
```
`permissions` is for showing/hiding UI only; the server enforces them on every call.

| Method & path | Auth | Body | Result |
|---|---|---|---|
| `POST /auth/login` | — | `{ identifier, password }` | session. Gym host: owner/staff (`identifier` = email or phone, `98765 43210` accepted). Platform host: super admin. |
| `POST /auth/magic-link` | — | `{ email }` | `202` always (never reveals membership). Emails a link to `https://<gym>…/login/verify?token=…`, valid 15 min, single use. Max 3 per member per 15 min. Gym host only. |
| `POST /auth/magic-link/verify` | — | `{ token }` | session (member). `400 INVALID_LINK` if used, expired, or from another gym. |
| `POST /auth/password/forgot` | — | `{ email }` | `202` always. Owners/staff only. Link to `/reset-password?token=…`, 30 min. |
| `POST /auth/password/reset` | — | `{ token, password }` | `204`. Also completes staff/owner **invites**. Ends all sessions. |
| `POST /auth/password/change` | Bearer | `{ currentPassword, newPassword }` | `204`. Ends all *other* sessions. Not for members. |
| `POST /auth/refresh` | cookie | — | new session + rotated cookie |
| `POST /auth/logout` | cookie | — | `204`, cookie cleared, session ended |
| `POST /auth/logout-all` | Bearer | — | `204`, every device signed out |
| `GET /auth/session` | cookie | — | `{ scope: "tenant"\|"platform", role }` for the refresh cookie, read-only (no rotation). Used by the web server to guard owner/platform pages before rendering; 401 `INVALID_REFRESH` otherwise |
| `GET /auth/me` | Bearer | — | `{ user, scope: "tenant"|"platform", gym: { name, slug } | null, impersonatedBy: { id, name } | null }` |
| `GET /auth/sessions` | Bearer | — | my active devices `[{ id, current, impersonated, createdAt, lastUsedAt, userAgent, ip }]` |
| `POST /auth/impersonation/end` | Bearer (impersonation) | — | `204`, ends the "log in as owner" session. `400` on a normal session. |
| `DELETE /auth/sessions/:id` | Bearer | — | `204` (own sessions only; others → `404`) |

Rate limits on login / email-link / forgot / reset: 10 attempts per IP + gym + account and
30 per IP + gym, per 15 minutes. After 5 wrong passwords an account locks for 15 minutes
(`429 LOGIN_LOCKED`); a password reset unlocks it.

Cookie-based endpoints (`/refresh`, `/logout`) reject requests whose `Origin` is a different host
(`403 CROSS_ORIGIN_REJECTED`).

While signed in as the owner from the platform, `password/change`, `logout-all` and
`DELETE /sessions/:id` return `403`: a super admin can't change the owner's credentials or sign the
owner out.

## Gym settings — `/api/v1/gym` (gym host)

Always the host's gym; the body can't name another one.

| Method & path | Permission | Body | Result |
|---|---|---|---|
| `GET /gym` | `gym:read` (owner, staff) | — | gym view (below) |
| `PATCH /gym` | `gym:update` (owner) | any of `name, email, phone, address{…}, settings{timezone, gstin, receiptPrefix, renewalReminderDays, renewalRemindersEnabled}` | gym view |
| `PATCH /gym/branding` | `branding:update` (owner) | any of `logoUrl` (https), `appIconUrl`, `coverImageUrl` (uploads of ours, see below), `primaryColor, secondaryColor` (`#RRGGBB`), `defaultTheme` (`dark`/`light`/`system`) | gym view (`branding.updatedAt` bumped) |

Patches merge: sending `settings.timezone` leaves the other settings alone. `null` clears an optional
field. An empty body is `422`.

Gym view: `{ id, name, slug, status, email, phone, customDomain, customDomainVerified, address{…},
settings{…}, branding{…}, subscription{ status, planCode, priceMonthlyPaise, currentPeriodEnd },
suspendedAt, suspendedReason, createdAt, updatedAt }`. Money in integer paise.

## Audit log — `/api/v1/audit-logs` (gym host)

`GET /audit-logs?page&limit&action&actorId&from&to` · permission `audit:read` (owner only).
Newest first. Includes what super admins did to the gym, so platform access is never invisible to
the owner.

Entry: `{ id, action, actor{ type: user|platform_admin|system, id, name, role }, impersonator{ id, name } | null,
target{ type, id } | null, changes[{ field, from, to }], metadata, ip, userAgent, requestId, createdAt }`.
Email and phone values appear as `[hidden]` in `changes`.

Actions so far: `auth.login`, `auth.account_locked`, `auth.invite_accepted`, `auth.password_reset`,
`auth.password_change`, `auth.logout_all`, `gym.update`, `gym.branding_update`, `tenant.create`,
`tenant.update`, `tenant.branding_update`, `tenant.suspend`, `tenant.activate`, `tenant.owner_invite`,
`impersonation.start`, `impersonation.end`, `staff.create`, `staff.update`,
`staff.permissions_update`, `staff.deactivate`, `staff.activate`, `staff.invite`, `member.create`,
`member.update`, `member.self_update`, `member.archive`, `member.restore`, `member.photo_update`,
`member.photo_remove`, `member.import`, `plan.create`, `plan.update`, `plan.archive`, `plan.restore`, `membership.create`, `membership.renew`,
`membership.cancel`, `payment.record`, `payment.refund`, `payment.refund_failed`,
`gym.payment_gateway_update`, `gym.payment_gateway_remove`, `notification.retry`, `notification.cancel`, `member.export`, `member.self_export`, `member.erase`. Member names, birth dates,
notes and emergency contacts are also shown as `[hidden]`.

## Staff — `/api/v1/staff` (gym host)

The gym's team. Reading needs `staff:read`, changes need `staff:manage` (both owner-only; neither can
be granted to staff). Owners appear in the list but can only be changed from the platform console.

| Method & path | Body / query | Result |
|---|---|---|
| `GET /staff` | `?q&role=owner|staff&status&page&limit` | `[staff view]` + page meta |
| `GET /staff/:id` | — | staff view (owners too) |
| `POST /staff` | `{ name, email, phone?, permissions?: grantable[] }` | `201 { staff, inviteSent, inviteError }`. Starts `invited`; an invite email lets them set a password. **Email is required.** |
| `PATCH /staff/:id` | any of `name, email, phone (null clears), permissions` | staff view |
| `POST /staff/:id/deactivate` | — | staff view. Ends all their sessions immediately. `409` if already disabled. |
| `POST /staff/:id/activate` | — | staff view (`active`, or `invited` if they never set a password) |
| `POST /staff/:id/invite` | — | `202 { sent, reason }`. `409` once accepted. |

Staff view: `{ id, name, email, phone, role, status: invited|active|disabled, grants[], permissions[], lastLoginAt, createdAt }`.
`grants` are the owner's extra grants; `permissions` is the full effective set.
Grantable: `reports:read, payments:refund, members:archive, members:import, plans:manage, renewals:manage`.

Email and phone are unique per gym across **all** roles: a person can't be staff and member of the
same gym with the same email (`409 DUPLICATE`).

## Members — `/api/v1/members` (gym host)

| Method & path | Permission | Body / query | Result |
|---|---|---|---|
| `GET /members` | `members:read` | `?q&archived=true|false&sort=-joinDate|joinDate|name|memberCode&joinedFrom&joinedTo&status=active|expiring|upcoming|expired|none&due=true|false&page&limit` | `[{ id, memberCode, name, phone, email, photoUrl, joinDate, appAccess, archivedAt, membership, balanceDuePaise }]` + page meta (see below) |
| `GET /members/:id` | `members:read` | — | member detail |
| `POST /members` | `members:create` | `{ name, phone, email?, gender?, dateOfBirth?, joinDate?, emergencyContact?{ name, phone, relation? }, notes?, consent: true }` | `201` member detail |
| `PATCH /members/:id` | `members:update` | any create field except `consent`; `null` clears `email, gender, dateOfBirth, emergencyContact, notes` | member detail. `409` if archived. |
| `POST /members/:id/archive` | `members:archive` | — | member detail; ends their app sessions |
| `POST /members/:id/restore` | `members:archive` | — | member detail |
| `GET /members/me` | `self:read` (members) | — | own profile (no staff notes) |
| `PATCH /members/me` | `self:update` (members) | any of `gender, dateOfBirth, emergencyContact, monthlyVisitGoal` (integer 1–31; `null` clears) | own profile |

- **Membership column.** Each list row has the member's current membership, picked like the
  profile (active, else the next upcoming, else the latest; cancelled ones ignored):
  ```json
  "membership": {
    "status": "active",              // active | upcoming | expired | none
    "expiringSoon": true,            // active, ends within renewalReminderDays, not renewed
    "plan": { "id": "…", "name": "Monthly" },   // null when status is none
    "startDate": "2026-10-24", "endDate": "2026-11-23",
    "daysLeft": 6,                   // incl. today if active; until start if upcoming; else null
    "nextStartDate": null            // a renewal already queued after the active one
  },
  "balanceDuePaise": 100000          // owed across all non-cancelled memberships (never negative)
  ```
- `status` filters on that column; `status=expiring` uses the same rule as
  `GET /memberships/expiring`. `due=true` keeps members with `balanceDuePaise > 0`. Filters combine
  with `q`, `archived`, join dates, sorting and paging; `meta.total` counts the filtered set.
- `q` matches name, email, phone digits (3+) or the start of the member code. Typed text is never
  treated as a pattern.
- Dates are `YYYY-MM-DD`. `joinDate` defaults to today in the gym's time zone; it may be back-dated
  but not more than a month ahead. Birth dates must be at least 3 years in the past.
- `memberCode` (`M0001`, `M0002`…) is assigned per gym, never reused, unique under concurrent
  registrations.
- **Consent:** registration requires `consent: true`. The front desk confirms the member agreed to the
  gym storing their details; the API stores when, which wording version (`v1`) and who recorded it.
- **App access** follows the email: with an email (and not archived) the member can sign in by email
  link; adding an email turns it on, removing it or archiving turns it off and ends their sessions.
  `appAccess: { enabled, reason: null|no_email|archived, lastLoginAt }`.
- Phone and email are unique per gym, including archived members (restore them instead of
  re-registering). The same person can be a member of two gyms.

### CSV import — `POST /members/import` (`members:import`)

Body: the CSV file itself, `Content-Type: text/csv` (max 1 MB, 2,000 rows).
Query: `dryRun=true` (default) validates only; `dryRun=false&consentConfirmed=true` imports.

Columns (header row, any order, case-insensitive): **`name`**, **`phone`** (or `mobile`), `email`,
`gender`, `date_of_birth` (or `dob`), `join_date`, `emergency_contact_name`,
`emergency_contact_phone`, `emergency_contact_relation`, `notes`. Dates as `YYYY-MM-DD` or
`DD/MM/YYYY`. Unknown columns are ignored. Excel CSV exports (with BOM, quoted cells) work.

Report: `{ dryRun, total, valid, errorCount, errors: [{ row, field, message }], created, firstCode?, lastCode? }`.
`row` is the line number as the spreadsheet shows it (header = 1). Checks: each row like the
registration form, duplicate phone/email within the file, and clashes with this gym's members and logins.

**All or nothing:** if any row has an error, a real import returns `422 IMPORT_INVALID` with the
report in `error.details` and writes nothing. A clean real import returns `201`. Missing
`consentConfirmed=true` → `422`. Bad file (empty, no `name`/`phone` column, too many rows) → `400`.

Member detail: `{ id, memberCode, name, phone, email, gender, dateOfBirth, joinDate,
emergencyContact, photoUrl, monthlyVisitGoal, notes, consent{ at, version }, appAccess, archivedAt, createdAt, updatedAt }`.
`monthlyVisitGoal` (1–31 or `null`) is set by the member in the app; staff can see it but not change it.

## Plans — `/api/v1/plans` (gym host)

Reading needs `plans:read` (owner, staff); changes need `plans:manage` (owner; grantable to staff).

| Method & path | Body / query | Result |
|---|---|---|
| `GET /plans` | `?archived=true|false&page&limit` | plans, shortest first |
| `GET /plans/:id` | — | plan |
| `POST /plans` | `{ name, duration: monthly|quarterly|half_yearly|yearly, pricePaise, description?, taxMode?, gstRate? }` | `201` plan |
| `PATCH /plans/:id` | any of the above (`description: null` clears) | plan. `409` if archived. |
| `POST /plans/:id/archive` · `/restore` | — | plan. Archived plans can't be sold; restoring can clash on name (`409`). |

Plan: `{ id, name, description, duration, months (1|3|6|12), pricePaise, taxMode: inclusive|exclusive|none, gstRate: 0|5|12|18|28, breakdown{ basePaise, gstPaise, totalPaise }, archivedAt, createdAt, updatedAt }`.

- `inclusive`: price contains GST (₹1,500 at 18% = ₹1,271.19 + ₹228.81). `exclusive`: GST is added on
  top. `none`: no GST.
- Default: `inclusive` at 18% if the gym has a GSTIN in settings, otherwise `none`. A gym without a
  GSTIN can't create GST plans (`422`).
- Lengths (owner's decision): `monthly` (1 month), `quarterly` (3), `half_yearly` (6), `yearly` (12).
- Live plan names are unique per gym, ignoring case.
- Editing a plan changes future sales only; memberships keep the price they were sold at.

## Memberships (gym host)

Reading needs `memberships:read`, selling/renewing/cancelling `memberships:manage` (owner and staff).

| Method & path | Body / query | Result |
|---|---|---|
| `GET /members/:id/memberships` | — | `{ summary, items[] }` newest first |
| `POST /members/:id/memberships` | `{ planId, startDate?, discountPaise?, notes? }` | `201` membership. `startDate` defaults to today; up to 1 year back or 90 days ahead. |
| `POST /members/:id/memberships/renew` | `{ planId?, startFrom?: expiry|today, discountPaise?, notes? }` | `201` membership |
| `POST /memberships/:id/cancel` | `{ reason }` | membership. Only active/upcoming; `409` otherwise. |
| `GET /memberships` | `?status=active|upcoming|expired|cancelled&planId&page&limit` | memberships with `member{ id, memberCode, name, phone, photoUrl, archived }`, soonest end first |
| `GET /memberships/expiring` | `?days&page&limit` | active memberships ending within `days` (default: gym's `renewalReminderDays`), whose member hasn't renewed and isn't archived. `meta.until`. |
| `GET /members/me/memberships` | `self:read` (member) | own `{ summary, items[] }`, without notes/staff fields; each `plan` also has `description` (the plan's current free text, one item per line, or `null`) |

Membership: `{ id, memberId, plan{ id, name, duration, months, pricePaise, taxMode, gstRate }, discountPaise,
basePaise, gstPaise, totalPaise, startDate, endDate, kind: new|renewal, status, daysLeft, cancelledAt,
cancelReason, notes, soldBy, previousMembershipId, createdAt }`.

- **Status is derived** from the dates against today in the gym's time zone: `upcoming` (starts
  later), `active`, `expired`, or `cancelled`. `daysLeft` counts today for active ones.
- `startDate`/`endDate` are `YYYY-MM-DD`, both inclusive. Lengths are **calendar months**: the
  membership ends the day before the same date N months later (monthly from 15 Jan → 14 Feb;
  quarterly from 10 Apr → 9 Jul). If that date doesn't exist it runs to the month's end (monthly from
  31 Jan → 28/29 Feb). Renewals from expiry follow on with no gap (next one starts 1 Mar).
- The plan's price and tax are **copied at sale**; editing the plan later changes nothing sold.
- Discount (paise) comes off the price before GST; it can't exceed the price.
- **No overlaps**: `409 CONFLICT` with `details{ endDate, availableFrom }` of the clashing membership.
- **Renew**: `expiry` starts the day after the latest membership ends, even if that is in the past
  (a lapse isn't free); `today` starts today and is refused while one is still running. Default:
  `expiry` while the latest is current/upcoming, otherwise `today`. Plan defaults to the last one.
- `summary`: `{ status: active|upcoming|expired|none, current, nextStartDate }`. Member detail
  (`GET /members/:id`) includes the same object as `membership`.

## Payments (gym host)

Reading needs `payments:read`; recording `payments:record` (owner and staff).

**Every request that records money needs an `Idempotency-Key` header** (8–100 of `A-Z a-z 0-9 _ -`;
a UUID is ideal). Retrying with the same key returns the original result (`200`, header
`Idempotent-Replayed: true`) instead of charging twice. The same key with a different amount, method
or member is `409`. Generate a new key per intended payment, reuse it only for retries.

| Method & path | Body / query | Result |
|---|---|---|
| `POST /memberships/:id/payments` | `{ amountPaise, method: cash|upi|card|bank_transfer, reference?, receivedAt?, notes? }` | `201` payment with `membership` (new balance) |
| `POST /members/:id/memberships` · `/renew` | usual body + `payment?: { … as above }` | `201` membership + `payment`: sale, payment and receipt in one transaction |
| `GET /payments` | `?from&to` (gym-local dates, inclusive) `&method&memberId&page&limit` | payments with `member`; `meta.totals{ receivedPaise, refundedPaise, netPaise }` over the whole filter |
| `GET /payments/:id` | — | payment with `membership` |
| `GET /members/:id/payments` | — | that member's payments |
| `GET /members/me/payments` | `self:read` (member) | own payments, without staff fields |
| `POST /payments/:id/refunds` | `{ amountPaise, reason, method?: cash|upi|bank_transfer }` + `Idempotency-Key`; needs `payments:refund` (owner; grantable) | `201` payment with `refunds[]` and new membership balance |
| `GET /payments/:id/receipt` | — | **PDF receipt** (`application/pdf`, inline, `receipt-RCPT-2026-27-0042.pdf`) |
| `GET /members/me/payments/:id/receipt` | `self:read` (member) | own PDF receipt; someone else's is `404` |
| `GET /memberships?due=true` | — | memberships (not cancelled) with money owed |

Payment: `{ id, receiptNumber, financialYear, memberId, membershipId, amountPaise, refundedPaise, method,
reference, receivedAt, receivedBy, notes, gateway, createdAt }`.

- Memberships now carry `paidPaise`, `balancePaise` (negative = overpaid) and
  `paymentStatus: unpaid|partial|paid|overpaid`. Part payments are normal.
- A desk payment above the balance due is `422`. Cancelled memberships take no payments (`409`);
  expired ones can still collect old dues.
- **Refunds** can be partial and repeated, never more than what is left on the payment (atomic
  guard). Each gets `RFND/<FY>/<n>` (per gym, per FY, gap-free) and moves the membership balance in the
  same transaction. Refunding doesn't cancel the membership; cancel separately if needed. Online
  (Razorpay) payments are refunded through the gateway (step 4). Members see their refunds without the
  internal reason. `refunds[]`: `{ id, refundNumber, amountPaise, method, status, refundedAt, reason, refundedBy }`.
- `receivedAt` defaults to now; up to 90 days back for late entry, never in the future.
- **Receipt numbers**: `<receiptPrefix>/<financial year>/<4+ digits>`, e.g. `RCPT/2026-27/0042`.
  Per gym, per Indian financial year (April–March, by the gym's local date of `receivedAt`).
  Allocated inside the payment's transaction: unique and gap-free, a failed payment uses no number.
- **Receipt PDF** (A5): gym name/address/GSTIN, receipt no. and date (gym time zone), member, plan
  and period, price, discount, taxable value, CGST + SGST at half the rate each (odd paisa to SGST,
  only when the gym charges GST), total, this payment and mode/reference, paid to date, balance due.
  Amounts print as `Rs. 1,500.00` (standard PDF fonts have no ₹ glyph).

## Online payments — Razorpay (gym host)

Each gym connects **its own** Razorpay account; money lands with the gym. Test keys only unless the
server sets `RAZORPAY_ALLOW_LIVE=true`. Desk payments work whether or not Razorpay is connected.

| Method & path | Who | Body | Result |
|---|---|---|---|
| `GET /gym/payment-gateway` | owner (`gym:update`) | — | `{ available, razorpay{ connected, keyId, mode: test|live, liveAllowed, webhookUrl, updatedAt } }` |
| `PUT /gym/payment-gateway/razorpay` | owner, not while impersonated | `{ keyId: rzp_test_…, keySecret, webhookSecret }` | settings. Secrets are stored encrypted, never returned. |
| `DELETE /gym/payment-gateway/razorpay` | owner, not while impersonated | — | settings (disconnected) |
| `POST /memberships/:id/razorpay-order` | `payments:record` | `{ amountPaise? }` (default: balance; min ₹1) | `201` Checkout params |
| `POST /members/me/memberships/:id/razorpay-order` | member (`self:pay`), own membership only | `{ amountPaise? }` | `201` Checkout params |
| `POST /payments/razorpay/verify` | `payments:record` or member (own orders only) | `{ orderId, paymentId, signature }` from Checkout | `201` payment (`200` if already recorded); `409 DUPLICATE_PAYMENT { details: { alertId } }` if the order was already paid by a different payment |
| `POST /webhooks/razorpay` | Razorpay (signed) | raw Razorpay event | `200 { status: captured|duplicate_refund_due|refund_processed|refund_failed|ignored|duplicate }` (`duplicate` = event id already handled) |
| `GET /gym/payment-gateway/alerts?status=duplicate_refund_due|resolved|all` | `payments:refund` (owner; grantable) | default: open alerts | `{ openCount, items[{ id, kind: duplicate_payment, status, amountPaise, razorpayOrderId, razorpayPaymentId, appliedRazorpayPaymentId, membershipId, memberId, memberName, source: checkout|webhook, createdAt, resolvedAt, resolutionNote }] }` (latest 200) |
| `POST /gym/payment-gateway/alerts/:id/resolve` | `payments:refund` | `{ note }` (3–500 chars) | the alert, `status: resolved`. `409` if already resolved. |

Checkout params: `{ keyId, orderId, amountPaise, currency: "INR", name, description, prefill{ name, email, contact } }`
→ pass to Razorpay Checkout (`key`, `order_id`, `amount`, …). On success send its
`razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature` to `/payments/razorpay/verify`.

- **Webhook setup** (Razorpay dashboard → Webhooks): URL from `GET /gym/payment-gateway`
  (`https://<gym>.yourapp.in/api/v1/webhooks/razorpay`), the same secret as `webhookSecret`, events
  `payment.captured`, `order.paid`, `refund.processed`, `refund.failed`. The webhook records payments
  even if the member closes the browser before `verify`; whichever arrives first wins, the other is a
  no-op.
- Online payments are recorded even if they exceed the balance (money was taken); the membership
  then shows `paymentStatus: overpaid` and the owner can refund the excess.
- **Duplicate payments on one order** (member paid twice: two tabs, a retried UPI intent): an order
  pays its membership exactly once. A second, different captured payment for an already-paid order
  is **not** applied (no payment row, no receipt, balance and dates unchanged). It is recorded as an
  alert with `status: duplicate_refund_due` and an audit entry (`payment.duplicate_gateway_payment`).
  Nothing is refunded automatically: the owner refunds it in the Razorpay dashboard, then resolves
  the alert (audited as `payment.duplicate_gateway_payment_resolve`). The dashboard shows
  `alerts.duplicatePaymentsRefundDue` to users with `payments:refund` (`null` for others). The same
  payment arriving by both checkout and webhook is not a duplicate.
- **Refunds** of online payments (`POST /payments/:id/refunds`) go through Razorpay to the original
  method: recorded first as `pending`, then `processed` (or reverted as `failed` if Razorpay refuses →
  `502 PAYMENT_GATEWAY_ERROR`, or later via the `refund.failed` webhook).

## Attendance (gym host)

| Method & path | Who | Body / query | Result |
|---|---|---|---|
| `GET /members/me/pass` | member (`self:read`) | — | `{ token, refreshAt, validUntil, member{ name, memberCode, photoUrl }, membershipStatus, checkedInToday }` |
| `POST /attendance/scan` | `attendance:checkin` (owner, staff) | `{ token }` from the member's QR | check-in result |
| `POST /attendance/manual` | `attendance:checkin` | `{ memberId }` | check-in result |
| `GET /attendance` | `attendance:read` | `?date` (default today) `&page&limit` | that day's check-ins with `member`, newest first; `meta.date` |
| `GET /attendance/report` | `attendance:read` | `?date` | `{ date, total, byMethod{ qr, manual }, byHour[24]{ hour, count }, busiestHour, activeMembers, attendanceRate }` |
| `GET /members/:id/attendance` | `attendance:read` | `?from&to&page&limit` | that member's visits, newest first |
| `GET /members/me/attendance` | member (`self:read`) | same | own visits |
| `GET /members/me/stats` | member (`self:read`) | — | `{ today, lifetimeVisits, thisMonth, thisWeek, week: boolean[7], checkedInToday, currentStreak, bestStreak, monthlyVisitGoal, badges: [{ visits: 1\|10\|25\|50\|100, earnedOn }] }` |

Check-in result: `201 { status: "checked_in", … }` or `200 { status: "already_checked_in", … }`, with
`checkIn{ id, day, checkedInAt, method }`, `member{ id, name, memberCode, phone, photoUrl }` and
`membership{ id, plan, endDate, daysLeft, balancePaise, paymentStatus }`. Show the photo and any balance
due to the desk.

- **QR pass**: render `token` as a QR code; fetch a new one at `refreshAt` (every 30 s). A scanned
  token is accepted for about 60–90 s. Errors: `400 PASS_EXPIRED` (ask the member to refresh),
  `400 PASS_INVALID` (not a pass for this gym).
- **One check-in per member per day** (gym time zone). Repeats return `already_checked_in`, never an error.
- **Admission** needs a membership active today, otherwise `409 NO_ACTIVE_MEMBERSHIP` with
  `details{ reason: expired|upcoming|none, date }` and a message like "Membership expired on 2026-11-10".
- `attendanceRate` = check-ins ÷ members with an active membership that day (0–1).

## Dashboard & reports (gym host)

### `GET /dashboard` — `dashboard:read` (owner, staff)
```jsonc
{
  "date": "2026-11-17",                                   // gym-local today
  "members": { "total": 4, "active": 2, "newThisMonth": 0 }, // active = membership active today
  "attendanceToday": { "checkIns": 1, "rate": 0.5 },
  "pendingRenewals": { "expiringSoon": 1, "windowDays": 7, "recentlyLapsed": 1 },
  "dues": { "outstandingPaise": 500000, "memberships": 2 },
  "revenue": {                                            // null unless the caller has reports:read
    "thisMonth": { "from": "2026-11-01", "to": "2026-11-17", "receivedPaise": 0, "refundedPaise": 0, "netPaise": 0 },
    "lastMonth": { "from": "2026-10-01", "to": "2026-10-31", "receivedPaise": 0, "refundedPaise": 0, "netPaise": 0 }
  }
}
```
`expiringSoon`: ending within the gym's `renewalReminderDays`, not renewed, member not archived.
`recentlyLapsed`: ended in the last 30 days without a renewal. **Revenue is hidden from front-desk
staff** (owner's numbers); grant `reports:read` to show it.

### `GET /reports/{revenue|memberships|attendance|growth|renewals}` — `reports:read` (owner; grantable)
Query: `from`, `to` (gym-local `YYYY-MM-DD`, inclusive, ≤ 366 days; default the last 30 days) and
`groupBy=day|week|month` (default by range length: ≤ 31 days → day, ≤ 92 → week, else month; weeks
start Monday). Every report returns `{ from, to, groupBy, series[], totals, … }`; `series` has one
row per period **including empty ones**, so charts need no gap-filling. Day, week and month totals
always agree.

| Report | `series[]` row | Extra |
|---|---|---|
| `revenue` | `{ period, receivedPaise, refundedPaise, netPaise, payments, refunds }` (refunds by the day they were made) | `byMethod{ cash|upi|card|bank_transfer|razorpay: { receivedPaise, payments } }` |
| `memberships` | `{ period, sold, new, renewals, valuePaise, discountPaise, cancelled }` (by sale date) | `byPlan[]{ plan, sold, valuePaise }` |
| `attendance` | `{ period, checkIns }` | `totals{ checkIns, uniqueMembers, averagePerDay }`, `byHour[24]`, `byWeekday[7]` |
| `growth` | `{ period, asOf, joined, archived, totalMembers, activeMembers }` (the last two as of the period's end) | `totals{ joined, archived, netChange }` |
| `renewals` | `{ period, ending, renewedOnTime, renewedLate, notRenewed, pending, renewalRate }` (by end date) | `renewalRate` = renewed ÷ (renewed + not renewed); `pending` = ends today or later, not renewed yet |

## Renewal reminders (gym host)

Two scheduled jobs (see DEPLOYMENT.md) email members automatically:
- **Hourly scan** queues one `renewal_expiring` reminder per membership ending within the gym's
  `renewalReminderDays` (started, not renewed, member not archived), and one `renewal_expired` within
  3 days after it ends without a renewal. Idempotent: never more than one of each per membership.
- **Dispatcher** (every 5 min) sends due reminders **only 09:00–20:00 gym time**. It re-checks at
  send time: renewed or cancelled → `cancelled`, archived → `cancelled`, no email → `skipped`; not allowed by the mail config → `skipped` with `reason: kind_not_enabled` or `recipient_not_allowed` (dev allow-list) (use the
  WhatsApp link instead). Failures retry after 5 min, 30 min, 2 h, 12 h; the 5th failure is `failed`.
- Owners switch it off with `PATCH /gym { settings: { renewalRemindersEnabled: false } }`.

| Method & path | Who | Result |
|---|---|---|
| `GET /notifications` | `renewals:manage` (owner; grantable) | `?status=queued|sending|sent|failed|skipped|cancelled&kind&page&limit` → `[{ id, kind, channel, status, attempts, nextAttemptAt, sentAt, reason, membershipId, member{ id, name, memberCode, phone }, createdAt }]` |
| `POST /notifications/:id/retry` | same | failed/skipped → queued (`409` otherwise) |
| `POST /notifications/:id/cancel` | same | queued → cancelled (`409` otherwise) |

## WhatsApp links (gym host)

`GET /members/:id/whatsapp?template=renewal|payment_due|welcome|custom&text=` (`members:read`) →
`{ template, phone, text, url }` where `url` is `https://wa.me/<digits>?text=<encoded>`. The desk opens
it and sends from the gym's own WhatsApp; the server sends nothing and there is no API cost.

- `renewal`: "your <plan> membership at <gym> ends on / ended on <date> … <app link>"
- `payment_due`: "a balance of ₹1,000 is due …" (`409` if nothing is due)
- `welcome`: member code and app link; `custom`: your own `text` (≤ 1000 chars)
- `409` for `renewal`/`payment_due` when the member has no membership.
- `GET /memberships/expiring` rows include a ready `whatsappUrl` (renewal message).

## Privacy — DPDP (gym host)

| Method & path | Who | Result |
|---|---|---|
| `GET /members/:id/export` | owner (`privacy:manage`) | JSON download of everything held: profile, consent, login (no secrets), memberships, payments + refunds, attendance, reminders |
| `GET /members/me/export` | member (`self:read`) | the same for themselves, without staff-internal notes |
| `POST /members/:id/erase` | owner (`privacy:manage`), not while impersonated | body `{ confirmMemberCode, reason }` → `{ memberCode, erasedAt, removed[], retained[] }` |

**Erase is irreversible.** Removed: name (becomes "Erased member M0005"), phone, email, birth date,
gender, emergency contact, notes (also on memberships/payments), photo (deleted from storage), the
member-app login, sessions, sign-in links, reminders. Kept, anonymised: member code, join date,
memberships, payments, refunds, receipt numbers (tax records), attendance dates, consent record.
Afterwards the member is archived and can't be restored or edited; their phone/email can be used by
a new registration. `privacy:manage` can't be granted to staff.

## Image uploads — `/api/v1/uploads` (gym host)

Images go straight from the browser to Cloudinary; the API only signs the upload.

1. `POST /uploads/signature` with `{ purpose: "member_photo", memberId }` (`members:update`) or
   `{ purpose: "gym_logo" | "gym_icon" | "gym_cover" }` (`branding:update`). Response:
   `{ uploadUrl, fields{ api_key, timestamp, public_id, allowed_formats, overwrite, signature }, publicId, deliveryUrl, expiresAt }`.
2. Browser: `POST uploadUrl` as `multipart/form-data` with every entry of `fields` plus `file`.
   Formats: jpg, jpeg, png, webp. The signature is valid for one hour.
3. Confirm:
   - member photo: `PUT /members/:id/photo { publicId }` → member detail with `photoUrl`;
     `DELETE /members/:id/photo` removes it. Replacing or removing deletes the old image from Cloudinary.
   - logo / icon / cover: `PATCH /gym/branding { logoUrl | appIconUrl | coverImageUrl: deliveryUrl }` (super admin:
     `PATCH /platform/tenants/:id/branding`).

`publicId` must be one the API could have issued for that member in this gym, otherwise `422`.

**App icon** (`appIconUrl`, the gym's favicon and home-screen icon): only owners (`branding:update`,
not grantable to staff) and super admins can set it. It must be a `deliveryUrl` from a `gym_icon`
upload for **this** gym, and the file Cloudinary actually stored (looked up with the Admin API, not
the browser's word) must be **PNG, JPG or WebP, ≤ 2 MB and square**; otherwise `422` on `appIconUrl`.
SVG is refused at upload already (`allowed_formats`) and again here. Replacing or clearing the icon
deletes the old file. Any branding change sets `branding.updatedAt`.

**Cover image** (`coverImageUrl`, the photo in the member app's Home hero; `null` = the app draws a
pattern in the gym colour): same rules as the icon (owners and super admins only, a `deliveryUrl`
from a `gym_cover` upload for **this** gym, checked against Cloudinary's record), but **PNG, JPG or
WebP, ≤ 5 MB, any shape**; otherwise `422` on `coverImageUrl`. Delivered at most 1920 px on its long
side (`c_limit`), in proportion; the app crops it to fit. Public (`GET /public/tenant`), like the logo.
Replacing or clearing it deletes the old file.
Without Cloudinary credentials these endpoints answer `503 UPLOADS_NOT_CONFIGURED`.

## Super admin console — `/api/v1/platform` (platform host, super admin only)

| Method & path | Body / query | Result |
|---|---|---|
| `GET /platform/tenants` | `?q&status&page&limit` (limit ≤ 100) | `[{ id, name, slug, status, city, subscriptionStatus, createdAt }]` + page meta |
| `GET /platform/tenants/slug-availability` | `?slug=` | `{ slug, available, reason: null|invalid|reserved|taken }` |
| `POST /platform/tenants` | `{ name, slug, email?, phone?, address?, settings?, branding?, subscription?, owner{ name, email, phone? } }` | `201 { tenant, appUrl, owner{ id, status: "invited" }, inviteSent, inviteError: null|throttled|send_failed|kind_not_enabled|recipient_not_allowed }`. The gym is created even if the email fails; resend it. `409` if the slug isn't available. |
| `GET /platform/tenants/:id` | — | `{ tenant, appUrl, owners[], userCounts{ owner, staff, member } }` |
| `PATCH /platform/tenants/:id` | gym profile fields + `subscription{…}` | gym view |
| `PATCH /platform/tenants/:id/branding` | branding fields (same app icon rules as the owner's) | gym view |
| `POST /platform/tenants/:id/uploads/signature` | `{ purpose: "gym_logo" \| "gym_icon" \| "gym_cover" }` | signed upload into that gym's branding folder (as `/uploads/signature`) |
| `POST /platform/tenants/:id/suspend` | `{ reason }` (3–500 chars) | gym view. The gym's next request gets `403 TENANT_SUSPENDED`; sessions are kept. |
| `POST /platform/tenants/:id/activate` | — | gym view. `409` if not suspended. |
| `POST /platform/tenants/:id/owner-invite` | — | `202 { sent, ownerId, reason: null|throttled|send_failed|kind_not_enabled|recipient_not_allowed }`. `409` if no owner is waiting. |
| `POST /platform/tenants/:id/impersonate` | `{ reason }` (≥ 10 chars) | `201 { accessToken, expiresIn, expiresAt, user, gym, appUrl }` |
| `GET /platform/tenants/:id/audit-logs` | audit filters | that gym's log |
| `GET /platform/audit-logs` | audit filters | platform log (super admin sign-ins) |

**Log in as owner.** The token is an owner access token for that gym's host only, valid for
`ACCESS_TOKEN_TTL_SEC` (15 min) and **not refreshable** (no cookie). `/auth/me` returns
`impersonatedBy`, and the dashboard must show a permanent banner while it is set. Every action is
logged with both the owner and the super admin. The gym must be active.
