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
| 401 | `UNAUTHORIZED` | (M2) |
| 403 | `FORBIDDEN`, `TENANT_SUSPENDED` | |
| 404 | `NOT_FOUND`, `ROUTE_NOT_FOUND`, `TENANT_NOT_FOUND` | unknown and archived gyms are indistinguishable |
| 409 | `CONFLICT`, `DUPLICATE` | duplicate values are never echoed back |
| 413 | `PAYLOAD_TOO_LARGE` | body > 100 kb |
| 422 | `VALIDATION_ERROR` | `details: [{ path, message }]` |
| 429 | `RATE_LIMITED` | |
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
