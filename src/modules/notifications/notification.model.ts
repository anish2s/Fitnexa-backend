import { Schema, model, type Types } from 'mongoose';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * Outgoing member messages (renewal reminders), queued by a scan and delivered by a dispatcher with
 * retries. Tenant-scoped. The address isn't stored here: it's read from the member at send time,
 * so a corrected or removed email is respected and the queue isn't another copy of personal data.
 */
export const NOTIFICATION_KINDS = ['renewal_expiring', 'renewal_expired'] as const;
export const NOTIFICATION_STATUSES = [
  'queued',
  'sending',
  'sent',
  'failed',
  'skipped',
  'cancelled',
] as const;

const notificationSchema = new Schema(
  {
    memberId: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
    membershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    channel: { type: String, enum: ['email'], default: 'email' },
    /** `<kind>:<membershipId>`: one reminder of each kind per membership, ever. */
    dedupeKey: { type: String, required: true, maxlength: 100 },
    status: { type: String, enum: NOTIFICATION_STATUSES, default: 'queued' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    claimedAt: { type: Date },
    sentAt: { type: Date },
    /** Why it was skipped/cancelled/failed: no_email, renewed, archived, or the last send error. */
    reason: { type: String, maxlength: 300 },
  },
  { timestamps: true },
);
notificationSchema.plugin(tenantScopePlugin);
notificationSchema.index({ tenantId: 1, dedupeKey: 1 }, { unique: true });
notificationSchema.index({ tenantId: 1, status: 1, nextAttemptAt: 1 });
notificationSchema.index({ tenantId: 1, memberId: 1, createdAt: -1 });
// Kept a year, like the audit log.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 86_400 });

export type LeanNotification = {
  _id: Types.ObjectId;
  memberId: Types.ObjectId;
  membershipId: Types.ObjectId;
  kind: (typeof NOTIFICATION_KINDS)[number];
  channel: 'email';
  status: (typeof NOTIFICATION_STATUSES)[number];
  attempts: number;
  nextAttemptAt: Date;
  sentAt?: Date | null;
  reason?: string | null;
  createdAt?: Date;
};
export const Notification = model('Notification', notificationSchema);
