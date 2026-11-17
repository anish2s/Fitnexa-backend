# Database

_Last updated: 2026-11-13 · Phase 1, Milestone 2_

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
| plans | `duration` (`monthly/quarterly/half_yearly/yearly`, owner's decision 2026-11-17) + derived `months`; `pricePaise`; `gstRatePct`; `isGstInclusive` | Gyms sell 15-day, 45-day, and 12+1-month plans; GST may be inclusive or exclusive. |
| memberships | Snapshot `plan { name, duration, months, pricePaise, gstRate }`; `amountPaise`, `discountPaise`, `paidPaise`, `balancePaise`; `cancelledAt`; drop stored `status` in favour of derived status + `renewalStatus` | Partial payments are common at Indian gyms; status computed from dates can't go stale. |
| payments | `amountPaise`, `mode` (cash/upi/card/bank/online), `gst { taxablePaise, cgstPaise, sgstPaise, igstPaise }`, `receiptNumber` (unique per tenant), `idempotencyKey` (unique per tenant), `gateway { orderId, paymentId, signatureVerified }`, `refunds[]`, `recordedBy` | Receipts, duplicate prevention, Razorpay verification, refunds, accountability. |
| attendance | Add `day` (YYYY-MM-DD in gym timezone), `recordedBy`; unique `{ tenantId, memberId, day }` | Hard guarantee against duplicate check-ins; fast daily reports. |
| auditLogs | Add `actorType` (platform/user), `impersonatorId`, `ip`, `userAgent`, `requestId`, `changes` (field-level before/after, PII-masked) | Required for audited impersonation and incident investigation. |
| **new** sessions | `userId`, `tenantId`, `refreshTokenHash`, `familyId`, `expiresAt` (TTL), `revokedAt`, `userAgent`, `ip` | Rotating refresh tokens, logout, logout-everywhere, reuse detection. |
| **new** authTokens | `type` (password_reset / invite / member_activation), `tokenHash`, `expiresAt` (TTL), `usedAt` | One-time links; only hashes stored. |
| **new** counters | `{ tenantId, key, seq }` unique on `{ tenantId, key }` | Gap-free receipt numbers per financial year (`RCPT/2026-27/000123`). |
| **new** jobLocks | `{ _id: jobName, lockedUntil, owner }` | One job run at a time across instances. |
| **new** notifications | `memberId`, `type`, `channel`, `status`, `attempts`, `sendAfter`, `payload` | Reminder queue with retry, visible in the dashboard. |

## Collections

### tenants ✅
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

`razorpay { keyId, keySecretEnc, webhookSecretEnc, updatedAt }`: the gym's own Razorpay account;
secrets are AES-256-GCM ciphertext (`select: false`).

Indexes: `{ slug: 1 } unique`, `{ customDomain: 1 } unique partial`, `{ status: 1 }`.

### platformAdmins ✅ (not tenant-scoped)
`src/modules/platform/platform-admin.model.ts`

`name`, `email` (unique), `passwordHash` (hidden by default), `status` (`active`/`disabled`),
`lastLoginAt`, `failedLogins`, `lockedUntil` (hidden), `passwordChangedAt`.
Created and reset only by `npm run admin:create`.

### users ✅ (tenant-scoped)
`src/modules/users/user.model.ts`. Everyone who signs in **inside a gym**.

| Field | Notes |
|---|---|
| name | required |
| email | lowercase; **required for members** (they sign in by email link) |
| phone | E.164 (`+919876543210`); owners/staff need email or phone |
| passwordHash | hidden by default; **forbidden for members** |
| role | `owner` / `staff` / `member` |
| memberId | link to the member record (M4) |
| permissions[] | extra grants for staff, filtered by `STAFF_GRANTABLE` |
| status | `invited` / `active` / `disabled` |
| lastLoginAt, failedLogins, lockedUntil, passwordChangedAt, archivedAt | |

Indexes: `{ tenantId, email } unique partial`, `{ tenantId, phone } unique partial`,
`{ tenantId, role, status }`. The same phone/email may exist in two gyms (tested).

### sessions ✅ (tenant-scoped) · platformSessions ✅ (not scoped)
`src/modules/auth/session.model.ts`. One document per signed-in device.

`userId`, `refreshTokenHash` (SHA-256; unique), `previousRefreshHashes[]` (last 5, for theft
detection), `rotatedAt`, `expiresAt` (**TTL index**: MongoDB deletes expired sessions), `revokedAt`,
`revokedReason` (`logout` / `logout_all` / `token_reuse` / `password_changed` / `user_disabled` / `admin` / `impersonation_end`),
`impersonatorId` (gym sessions only: the super admin behind a "log in as owner" session), `lastUsedAt`, `userAgent`, `ip`.

### authTokens ✅ (tenant-scoped)
`src/modules/auth/auth-token.model.ts`. Single-use emailed links.

`type` (`magic_link` / `password_reset` / `invite`), `userId`, `tokenHash` (unique per gym),
`expiresAt`, `usedAt`, `requestedIp`. TTL: deleted 24 h after expiry.

### members ✅ (tenant-scoped)
`src/modules/members/member.model.ts`. The gym's member record.

`memberCode` (`M0001`), `name`, `phone` (E.164, required), `email?`, `gender?`
(`male/female/other/undisclosed`), `dateOfBirth?`, `joinDate` (calendar dates stored as UTC midnight),
`emergencyContact { name, phone, relation }`, `notes` (staff only), `photoUrl`, `photoPublicId`,
`consent { at, version, recordedBy }`, `userId` (linked member login, when there is an email), `archivedAt`,
`erasedAt` (DPDP erasure; phone is required unless set).

Indexes: `{ tenantId, memberCode } unique`, `{ tenantId, phone } unique partial (phone is a string)`,
`{ tenantId, email } unique partial`, `{ tenantId, archivedAt, joinDate: -1 }`, `{ tenantId, userId }`.
A member's login is a `users` document (role `member`, `memberId` back-reference), created, updated and
disabled in the same transaction as the member.

### counters ✅ (tenant-scoped)
`src/modules/counters/counter.model.ts`. `key`, `seq`; `{ tenantId, key } unique`. Atomic `$inc` with
upsert. Keys: `memberCode`, `receipt:<financial year>` (e.g. `receipt:2026-27`), `refund:<financial year>`.

### paymentOrders ✅ · webhookEvents ✅ (tenant-scoped)
`src/modules/payments/payment-order.model.ts`. **paymentOrders**: `membershipId`, `memberId`,
`amountPaise`, `razorpayOrderId` (`{ tenantId, razorpayOrderId } unique`), `status` (`created/paid`),
`razorpayPaymentId`, `createdBy`, `createdVia` (`desk/member`). **webhookEvents**: `provider`, `eventId`
(`{ tenantId, provider, eventId } unique`), `event`; TTL 30 days on `createdAt`.

### attendance ✅ (tenant-scoped)
`src/modules/attendance/attendance.model.ts`. `memberId`, `membershipId` (the one that admitted them),
`day` (gym-local `YYYY-MM-DD`), `hour` (gym-local 0–23), `checkedInAt`, `method` (`qr/manual`), `recordedBy`.
Indexes: `{ tenantId, memberId, day } unique` (one visit per member per day), `{ tenantId, day, checkedInAt }`.

### jobLocks ✅ (platform, not scoped)
`src/jobs/job-lock.model.ts`. `_id` = job name, `lockedUntil`, `owner` (host:pid:random),
`lastStartedAt`, `lastFinishedAt`, `lastError`, `lastSummary`. A job runs only while holding the
lease (atomic upsert; a held lock makes the insert collide), so N instances run each job once.

### notifications ✅ (tenant-scoped)
`src/modules/notifications/notification.model.ts`. `memberId`, `membershipId`, `kind`
(`renewal_expiring/renewal_expired`), `channel` (`email`), `dedupeKey` (`<kind>:<membershipId>`),
`status` (`queued/sending/sent/failed/skipped/cancelled`), `attempts`, `nextAttemptAt`, `claimedAt`,
`sentAt`, `reason`. No address or message body stored (read from the member at send time).
Indexes: `{ tenantId, dedupeKey } unique`, `{ tenantId, status, nextAttemptAt }`,
`{ tenantId, memberId, createdAt: -1 }`; TTL 1 year on `createdAt`.

### plans ✅ (tenant-scoped)
`src/modules/plans/plan.model.ts`. `name`, `nameKey` (lower-cased), `description`, `duration` (`monthly/quarterly/half_yearly/yearly`), `months` (1/3/6/12, for sorting),
`pricePaise`, `taxMode` (`inclusive/exclusive/none`), `gstRate` (0/5/12/18/28), `archivedAt` (explicit
`null` while live). Indexes: `{ tenantId, archivedAt, months }`,
`{ tenantId, nameKey } unique partial (archivedAt null)`.

### memberships ✅ (tenant-scoped)
`src/modules/memberships/membership.model.ts`. `memberId`, `plan { planId, name, duration, months,
pricePaise, taxMode, gstRate }` (snapshot at sale), `discountPaise`, `basePaise`, `gstPaise`, `totalPaise`,
`startDate`, `endDate` (calendar dates, inclusive), `kind` (`new/renewal`), `previousMembershipId`,
`soldBy`, `notes`, `cancelledAt` (explicit null), `cancelledBy`, `cancelReason`.
Status is derived, never stored. Indexes: `{ tenantId, memberId, startDate: -1 }`,
`{ tenantId, cancelledAt, endDate }`, `{ tenantId, plan.planId }`, `{ tenantId, createdAt }` (memberships report).
Members carry a hidden `membershipRev` counter, bumped in every sale's transaction so concurrent sales
for one member serialise (overlap check can't be raced).

### payments ✅ (tenant-scoped)
`src/modules/payments/payment.model.ts`. `memberId`, `membershipId`, `amountPaise`, `method`
(`cash/upi/card/bank_transfer/razorpay`), `reference`, `receiptNumber`, `financialYear`, `receivedAt`,
`receivedBy`, `notes`, `idempotencyKey`, `gateway { provider, orderId, paymentId }`, `refundedPaise`,
`refunds[] { refundNumber, amountPaise, method, reason, status, refundedAt, refundedBy, idempotencyKey, gatewayRefundId }`
(+ index `{ tenantId, refunds.idempotencyKey } unique partial`).
Indexes: `{ tenantId, receiptNumber } unique`, `{ tenantId, idempotencyKey } unique partial`,
`{ tenantId, gateway.paymentId } unique partial`, `{ tenantId, membershipId, receivedAt }`,
`{ tenantId, memberId, receivedAt: -1 }`, `{ tenantId, receivedAt: -1 }`, `{ tenantId, refunds.refundedAt }` (revenue report).
Written only by `payment.ledger.ts` inside a transaction that also updates `memberships.paidPaise`
and the `receipt:<FY>` counter. Memberships gained `paidPaise` and index `{ tenantId, cancelledAt, paidPaise }`.

Field lists as in the review table above; each gets its own section here when implemented.

## Index migrations
`npm run db:indexes` only adds indexes. When an index's options change, drop the old one once by hand:

| Date | Collection | Change | Command (mongosh) |
|---|---|---|---|
| 2026-11-17 | `members` | `tenantId_1_phone_1` became partial (erased members have no phone) | `db.members.dropIndex("tenantId_1_phone_1")` then `npm run db:indexes` |
