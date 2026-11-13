import { Schema, model } from 'mongoose';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * Single-use links sent by email: member sign-in, password reset, staff/owner invites.
 * Only the SHA-256 of the token is stored; the token itself exists only in the email.
 * Consumption is a single atomic findOneAndUpdate, so a link can never be used twice.
 */
export const AUTH_TOKEN_TYPES = ['magic_link', 'password_reset', 'invite'] as const;
export type AuthTokenType = (typeof AUTH_TOKEN_TYPES)[number];

const authTokenSchema = new Schema(
  {
    type: { type: String, enum: AUTH_TOKEN_TYPES, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    requestedIp: { type: String, maxlength: 64 },
  },
  { timestamps: true },
);
authTokenSchema.plugin(tenantScopePlugin);
authTokenSchema.index({ tenantId: 1, tokenHash: 1 }, { unique: true });
authTokenSchema.index({ tenantId: 1, userId: 1, type: 1, createdAt: -1 });
// Keep used/expired tokens a day for investigation, then let MongoDB delete them.
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

export const AuthToken = model('AuthToken', authTokenSchema);
