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
| `GET /auth/me` | Bearer | — | `{ user, scope: "tenant"|"platform", gym: { name, slug } | null }` |
| `GET /auth/sessions` | Bearer | — | my active devices `[{ id, current, createdAt, lastUsedAt, userAgent, ip }]` |
| `DELETE /auth/sessions/:id` | Bearer | — | `204` (own sessions only; others → `404`) |

Rate limits on login / email-link / forgot / reset: 10 attempts per IP + gym + account and
30 per IP + gym, per 15 minutes. After 5 wrong passwords an account locks for 15 minutes
(`429 LOGIN_LOCKED`); a password reset unlocks it.

Cookie-based endpoints (`/refresh`, `/logout`) reject requests whose `Origin` is a different host
(`403 CROSS_ORIGIN_REJECTED`).
