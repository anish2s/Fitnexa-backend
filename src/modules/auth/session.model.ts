import { Schema, model } from 'mongoose';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * One document per login (device). The access token's `sid` points here.
 *
 * Refresh tokens rotate on every use: the current token's hash is in `refreshTokenHash`, recent
 * previous hashes in `previousRefreshHashes`. Presenting a previous token means it was copied
 * (stolen) → the whole session is revoked. A short grace window tolerates two browser tabs
 * refreshing at the same moment.
 *
 * Gym sessions and platform (super admin) sessions live in separate collections so the gym one can
 * stay tenant-scoped.
 */
function buildSessionSchema(tenantScoped: boolean) {
  const schema = new Schema(
    {
      userId: { type: Schema.Types.ObjectId, required: true },
      refreshTokenHash: { type: String, required: true },
      previousRefreshHashes: { type: [String], default: [] },
      rotatedAt: { type: Date },
      expiresAt: { type: Date, required: true },
      revokedAt: { type: Date },
      revokedReason: {
        type: String,
        enum: [
          'logout',
          'logout_all',
          'token_reuse',
          'password_changed',
          'user_disabled',
          'admin',
          'impersonation_end',
        ],
      },
      /**
       * Gym sessions only: the super admin behind a "log in as owner" session. Such a session has
       * no usable refresh token (the random hash is never revealed), so it dies with its access token.
       */
      impersonatorId: { type: Schema.Types.ObjectId },
      lastUsedAt: { type: Date },
      userAgent: { type: String, maxlength: 300 },
      ip: { type: String, maxlength: 64 },
    },
    { timestamps: true },
  );
  if (tenantScoped) schema.plugin(tenantScopePlugin);

  const prefix: Record<string, 1> = tenantScoped ? { tenantId: 1 } : {};
  schema.index({ ...prefix, refreshTokenHash: 1 }, { unique: true });
  schema.index({ ...prefix, previousRefreshHashes: 1 });
  schema.index({ ...prefix, userId: 1, revokedAt: 1 });
  // MongoDB deletes expired sessions automatically.
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return schema;
}

const tenantSessionSchema = buildSessionSchema(true);
const platformSessionSchema = buildSessionSchema(false);

export const Session = model('Session', tenantSessionSchema);
export const PlatformSession = model('PlatformSession', platformSessionSchema);
