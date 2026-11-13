# API

_Full OpenAPI/Swagger documentation is generated in Milestone 10. This file lists what exists now._

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
| 404 | `NOT_FOUND`, `ROUTE_NOT_FOUND`, `TENANT_NOT_FOUND` | unknown and archived gyms are indistinguishable |
| 409 | `CONFLICT`, `DUPLICATE` | duplicate values are never echoed back |
| 413 | `PAYLOAD_TOO_LARGE` | body > 100 kb |
| 422 | `VALIDATION_ERROR` | `details: [{ path, message }]` |
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
    "branding": {
      "logoUrl": "https://…",
      "appIconUrl": null,
      "primaryColor": "#E11D48",
      "secondaryColor": "#0F172A",
      "defaultTheme": "dark"
    }
  }
}
```
`status` is `active` or `suspended` (suspended gyms still show branding so the login page can explain).
Cached for 60 s.

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
| `PATCH /gym` | `gym:update` (owner) | any of `name, email, phone, address{…}, settings{timezone, gstin, receiptPrefix, renewalReminderDays}` | gym view |
| `PATCH /gym/branding` | `branding:update` (owner) | any of `logoUrl, appIconUrl` (https only), `primaryColor, secondaryColor` (`#RRGGBB`), `defaultTheme` (`dark`/`light`/`system`) | gym view |

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
`impersonation.start`, `impersonation.end`.

## Super admin console — `/api/v1/platform` (platform host, super admin only)

| Method & path | Body / query | Result |
|---|---|---|
| `GET /platform/tenants` | `?q&status&page&limit` (limit ≤ 100) | `[{ id, name, slug, status, city, subscriptionStatus, createdAt }]` + page meta |
| `GET /platform/tenants/slug-availability` | `?slug=` | `{ slug, available, reason: null|invalid|reserved|taken }` |
| `POST /platform/tenants` | `{ name, slug, email?, phone?, address?, settings?, branding?, subscription?, owner{ name, email, phone? } }` | `201 { tenant, appUrl, owner{ id, status: "invited" }, inviteSent }`. `409` if the slug isn't available. |
| `GET /platform/tenants/:id` | — | `{ tenant, appUrl, owners[], userCounts{ owner, staff, member } }` |
| `PATCH /platform/tenants/:id` | gym profile fields + `subscription{…}` | gym view |
| `PATCH /platform/tenants/:id/branding` | branding fields | gym view |
| `POST /platform/tenants/:id/suspend` | `{ reason }` (3–500 chars) | gym view. The gym's next request gets `403 TENANT_SUSPENDED`; sessions are kept. |
| `POST /platform/tenants/:id/activate` | — | gym view. `409` if not suspended. |
| `POST /platform/tenants/:id/owner-invite` | — | `202 { sent, ownerId, throttled }`. `409` if no owner is waiting. |
| `POST /platform/tenants/:id/impersonate` | `{ reason }` (≥ 10 chars) | `201 { accessToken, expiresIn, expiresAt, user, gym, appUrl }` |
| `GET /platform/tenants/:id/audit-logs` | audit filters | that gym's log |
| `GET /platform/audit-logs` | audit filters | platform log (super admin sign-ins) |

**Log in as owner.** The token is an owner access token for that gym's host only, valid for
`ACCESS_TOKEN_TTL_SEC` (15 min) and **not refreshable** (no cookie). `/auth/me` returns
`impersonatedBy`, and the dashboard must show a permanent banner while it is set. Every action is
logged with both the owner and the super admin. The gym must be active.
