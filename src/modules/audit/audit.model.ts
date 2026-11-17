import { Schema, model, type Query } from 'mongoose';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * Append-only record of sensitive actions.
 *
 * - `auditLogs` (tenant-scoped): everything that happens to or inside a gym, including what a super
 *   admin did there (gym created, suspended, "log in as owner"). The gym owner can read it, so
 *   platform access to a gym is never invisible to that gym.
 * - `platformAuditLogs` (not scoped): events with no gym, e.g. a super admin signing in.
 *
 * Values that identify people (email, phone) are never stored in `changes`, only the fact that they
 * changed, so the log itself doesn't become a second copy of personal data (DPDP).
 */
export const ACTOR_TYPES = ['user', 'platform_admin', 'system'] as const;

/**
 * Owner's decision (2026-11-17): keep audit entries for one year. MongoDB's TTL monitor removes
 * older entries server-side, which doesn't go through (or conflict with) the append-only hooks.
 */
export const AUDIT_RETENTION_DAYS = 365;

const changeSchema = new Schema(
  {
    field: { type: String, required: true, maxlength: 100 },
    from: { type: Schema.Types.Mixed },
    to: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

function buildAuditSchema(tenantScoped: boolean) {
  const schema = new Schema(
    {
      /** `<area>.<verb>`, e.g. tenant.suspend, auth.login, impersonation.start */
      action: { type: String, required: true, maxlength: 64, match: /^[a-z_]+\.[a-z_]+$/ },
      actor: {
        type: { type: String, enum: ACTOR_TYPES, required: true },
        id: { type: Schema.Types.ObjectId },
        name: { type: String, maxlength: 120 },
        role: { type: String, maxlength: 32 },
      },
      /** Set when a super admin acted while signed in as the gym owner. */
      impersonator: {
        id: { type: Schema.Types.ObjectId },
        name: { type: String, maxlength: 120 },
      },
      target: {
        type: { type: String, maxlength: 32 },
        id: { type: String, maxlength: 64 },
      },
      changes: { type: [changeSchema], default: undefined },
      metadata: { type: Schema.Types.Mixed },
      ip: { type: String, maxlength: 64 },
      userAgent: { type: String, maxlength: 300 },
      requestId: { type: String, maxlength: 64 },
    },
    { timestamps: { createdAt: true, updatedAt: false }, minimize: true },
  );
  if (tenantScoped) schema.plugin(tenantScopePlugin);

  const prefix: Record<string, 1> = tenantScoped ? { tenantId: 1 } : {};
  schema.index({ ...prefix, createdAt: -1 });
  schema.index({ ...prefix, action: 1, createdAt: -1 });
  schema.index({ ...prefix, 'actor.id': 1, createdAt: -1 });
  // TTL indexes must be single-field, so this one can't start with tenantId; it is never used to
  // query, only to expire.
  schema.index({ createdAt: 1 }, { expireAfterSeconds: AUDIT_RETENTION_DAYS * 24 * 3600 });

  // Application code can add entries but never edit or remove them.
  const blocked = [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ] as const;
  for (const op of blocked) {
    schema.pre(op, { query: true, document: false }, function (this: Query<unknown, unknown>) {
      throw new Error(`Audit log is append-only ("${op}" refused)`);
    });
  }
  return schema;
}

export const AuditLog = model('AuditLog', buildAuditSchema(true));
export const PlatformAuditLog = model('PlatformAuditLog', buildAuditSchema(false));
