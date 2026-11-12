# Database

_Last updated: 2026-11-12 · Phase 1, Milestone 1_

Shared MongoDB database, shared collections. Every tenant-owned collection uses `tenantScopePlugin`
(`src/tenancy/tenant-scope.plugin.ts`), which adds a required, indexed, immutable `tenantId` and
enforces it on every read and write.

Status legend: ✅ implemented & tested · 🟡 implemented, DB tests not yet run · ⬜ planned (milestone)

## Global rules

- **Money is integer paise** (`₹999` → `99900`). No floats anywhere near currency.
- **Every compound index on a tenant collection starts with `tenantId`**, so queries are both fast and
  naturally partitioned. Uniqueness that is "per gym" is a unique index on `{ tenantId, field }`.
- **Snapshots over references for history.** A membership copies the plan's name, price and GST at
  purchase time, so editing a plan never rewrites past invoices.
- **Soft delete** (`archivedAt`) for members and staff; hard delete only via the DPDP erase flow.
- **Transactions** (replica set) for multi-document financial writes: payment + membership + counter.
- `timestamps: true` on every schema (`createdAt`, `updatedAt`).

## Review of the proposed schema (spec §7 and whiteboard)

| Collection | Change | Reason |
|------------|--------|--------|
| tenants | `subdomain` merged into `slug`; branding/address/settings as sub-documents; `customDomainVerified`; `subscription { status, planCode, priceMonthlyPaise, currentPeriodEnd }`; `branding.defaultTheme` | One identifier for URL + DNS; a custom domain must not resolve until verified; theme support for the dashboard. |
| users | Split out **`platformAdmins`** (no tenantId) from tenant `users` | Keeps `users` strictly tenant-scoped; super admins can't accidentally match a gym query. |
| users | Add `memberId` (for role `member`), `permissions[]` overrides, `lastLoginAt`, `failedLogins`, `lockedUntil`, `passwordChangedAt` | Member logins link to a member record; lockout; invalidate tokens after password change. |
| members | Add `memberCode` (per-gym short id), `archivedAt`, `consent { at, version, channel }`, `notes`, `photoPublicId` | Front-desk lookup; DPDP consent; Cloudinary deletion needs the public id. |
| plans | `durationMonths` → `durationDays` + `durationLabel`; `pricePaise`; `gstRatePct`; `isGstInclusive` | Gyms sell 15-day, 45-day, and 12+1-month plans; GST may be inclusive or exclusive. |
| memberships | Snapshot `plan { name, durationDays, pricePaise, gstRatePct }`; `amountPaise`, `discountPaise`, `paidPaise`, `balancePaise`; `cancelledAt`; drop stored `status` in favour of derived status + `renewalStatus` | Partial payments are common at Indian gyms; status computed from dates can't go stale. |
| payments | `amountPaise`, `mode` (cash/upi/card/bank/online), `gst { taxablePaise, cgstPaise, sgstPaise, igstPaise }`, `receiptNumber` (unique per tenant), `idempotencyKey` (unique per tenant), `gateway { orderId, paymentId, signatureVerified }`, `refunds[]`, `recordedBy` | Receipts, duplicate prevention, Razorpay verification, refunds, accountability. |
| attendance | Add `day` (YYYY-MM-DD in gym timezone), `recordedBy`; unique `{ tenantId, memberId, day }` | Hard guarantee against duplicate check-ins; fast daily reports. |
| auditLogs | Add `actorType` (platform/user), `impersonatorId`, `ip`, `userAgent`, `requestId`, `changes` (field-level before/after, PII-masked) | Required for audited impersonation and incident investigation. |
| **new** sessions | `userId`, `tenantId`, `refreshTokenHash`, `familyId`, `expiresAt` (TTL), `revokedAt`, `userAgent`, `ip` | Rotating refresh tokens, logout, logout-everywhere, reuse detection. |
| **new** authTokens | `type` (password_reset / invite / member_activation), `tokenHash`, `expiresAt` (TTL), `usedAt` | One-time links; only hashes stored. |
| **new** counters | `{ tenantId, key, seq }` unique on `{ tenantId, key }` | Gap-free receipt numbers per financial year (`RCPT/2026-27/000123`). |
| **new** jobLocks | `{ _id: jobName, lockedUntil, owner }` | One job run at a time across instances. |
| **new** notifications | `memberId`, `type`, `channel`, `status`, `attempts`, `sendAfter`, `payload` | Reminder queue with retry, visible in the dashboard. |

## Collections

### tenants ✅ (model + unit-tested via HTTP; DB tests 🟡)
`src/modules/tenants/tenant.model.ts`

| Field | Type | Notes |
|---|---|---|
| name | string 2–120 | required |
| slug | string | required, unique, DNS label `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`; also the subdomain |
| customDomain / customDomainVerified | string / bool | partial unique index; resolves only when verified |
| branding | `{ logoUrl, appIconUrl, primaryColor, secondaryColor, defaultTheme }` | hex colours; theme `dark` (default) / `light` / `system` |
| address | `{ line1, line2, city, state, postalCode, country='IN' }` | |
| settings | `{ timezone='Asia/Kolkata', currency='INR', locale='en-IN', gstin, receiptPrefix='RCPT', renewalReminderDays=7 }` | |
| phone, email | string | |
| status | `active` / `suspended` / `archived` | indexed |
| subscription | `{ status, planCode, priceMonthlyPaise, currentPeriodEnd }` | platform billing |
| suspendedAt, suspendedReason | | |

Indexes: `{ slug: 1 } unique`, `{ customDomain: 1 } unique partial`, `{ status: 1 }`.

### platformAdmins ⬜ M2
`email` unique, `name`, `passwordHash`, `status`, `mfaEnabled` (later).

### users ⬜ M2 (tenant-scoped)
`name`, `email?`, `phone`, `passwordHash`, `role` (`owner` / `staff` / `member`), `memberId?`,
`permissions[]`, `status`, `lastLoginAt`, `failedLogins`, `lockedUntil`, `passwordChangedAt`, `archivedAt`.
Indexes: `{ tenantId, phone } unique`, `{ tenantId, email } unique partial`, `{ tenantId, role }`.

### members ⬜ M4 (tenant-scoped)
`memberCode`, `name`, `phone`, `email?`, `photoUrl`, `photoPublicId`, `dateOfBirth`, `gender`,
`joinDate`, `status`, `emergencyContact { name, phone, relation }`, `consent`, `notes`, `archivedAt`.
Indexes: `{ tenantId, phone } unique`, `{ tenantId, memberCode } unique`, `{ tenantId, status, joinDate }`,
text-ish search via `{ tenantId, nameLower }` prefix index (Atlas Search later if needed).

### plans ⬜ M5 · memberships ⬜ M5 · payments ⬜ M6 · attendance ⬜ M7 · auditLogs ⬜ M3 · sessions / authTokens ⬜ M2 · counters ⬜ M6 · jobLocks / notifications ⬜ M9

Field lists as in the review table above; each gets its own section here when implemented.
