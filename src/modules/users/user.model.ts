import { Schema, model, type InferSchemaType, type HydratedDocument, type Types } from 'mongoose';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * Login identities inside a gym: owners, staff and members. Tenant-scoped.
 *
 * - owner / staff log in with email-or-phone + password.
 * - members log in with a one-time email link and never have a password.
 * Platform super admins are a different collection (platformAdmins) and can never match here.
 */
export const USER_ROLES = ['owner', 'staff', 'member'] as const;
export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    /** E.164 without spaces, e.g. +919876543210. */
    phone: { type: String, trim: true, match: /^\+[1-9]\d{7,14}$/ },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: USER_ROLES, required: true },
    /** For role=member: the member record (members collection, Milestone 4). */
    memberId: { type: Schema.Types.ObjectId, ref: 'Member' },
    /** Extra permissions for staff; filtered against STAFF_GRANTABLE when evaluated. */
    permissions: { type: [String], default: [] },
    status: { type: String, enum: USER_STATUSES, default: 'active' },
    lastLoginAt: { type: Date },
    failedLogins: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, select: false },
    /** Access tokens and sessions created before this instant are invalid. */
    passwordChangedAt: { type: Date },
    archivedAt: { type: Date },
  },
  { timestamps: true },
);

userSchema.plugin(tenantScopePlugin);

userSchema.index(
  { tenantId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
userSchema.index(
  { tenantId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
);
userSchema.index({ tenantId: 1, role: 1, status: 1 });

userSchema.pre('validate', function () {
  const role = this.get('role') as string;
  if (role === 'member') {
    if (!this.get('email')) this.invalidate('email', 'Members need an email address to sign in');
    if (this.get('passwordHash')) this.invalidate('passwordHash', 'Members sign in by email link');
  } else if (!this.get('email') && !this.get('phone')) {
    this.invalidate('email', 'Owners and staff need an email or phone');
  }
});

export type UserAttrs = InferSchemaType<typeof userSchema> & { tenantId: Types.ObjectId };
export type UserDoc = HydratedDocument<UserAttrs>;
export const User = model('User', userSchema);

export function toPublicUser(u: {
  _id: unknown;
  name: string;
  email?: string | null;
  phone?: string | null;
  role: string;
  status?: string | null;
}) {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email ?? null,
    phone: u.phone ?? null,
    role: u.role,
    status: u.status ?? 'active',
  };
}
