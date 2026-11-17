import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * A gym's member record (the business record). Tenant-scoped.
 *
 * App access is separate: a member with an email has a linked `users` document (role member,
 * `userId` here, `memberId` there) and signs in by email link. Without an email there is no
 * login, but the member is otherwise fully managed by the front desk.
 */
export const GENDERS = ['male', 'female', 'other', 'undisclosed'] as const;
/** Bump when the consent wording shown at registration changes. */
export const MEMBER_CONSENT_VERSION = 'v1';

const memberSchema = new Schema(
  {
    /** Human-friendly per-gym number, e.g. M0042. Never reused. */
    memberCode: { type: String, required: true, maxlength: 20 },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    /** E.164. Required: the front desk's primary way to find and contact a member. */
    phone: { type: String, required: true, match: /^\+[1-9]\d{7,14}$/ },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    gender: { type: String, enum: GENDERS },
    dateOfBirth: { type: Date },
    joinDate: { type: Date, required: true },
    emergencyContact: {
      name: { type: String, trim: true, maxlength: 120 },
      phone: { type: String, match: /^\+[1-9]\d{7,14}$/ },
      relation: { type: String, trim: true, maxlength: 40 },
    },
    /** Staff-only notes; never shown to the member. */
    notes: { type: String, maxlength: 1000 },
    photoUrl: { type: String, maxlength: 500 },
    photoPublicId: { type: String, maxlength: 200 },
    /** DPDP: when consent was recorded, which wording, and by which staff user. */
    consent: {
      at: { type: Date, required: true },
      version: { type: String, required: true, maxlength: 20 },
      recordedBy: { type: Schema.Types.ObjectId },
    },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    /**
     * Bumped inside every membership sale's transaction. Two concurrent sales for the same member
     * both write this document, so MongoDB serialises them and the overlap check can't be raced.
     */
    membershipRev: { type: Number, default: 0, select: false },
    archivedAt: { type: Date },
  },
  { timestamps: true },
);

memberSchema.plugin(tenantScopePlugin);
memberSchema.index({ tenantId: 1, memberCode: 1 }, { unique: true });
// Archived members keep their phone/email reserved; restoring them must not collide.
memberSchema.index({ tenantId: 1, phone: 1 }, { unique: true });
memberSchema.index(
  { tenantId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
memberSchema.index({ tenantId: 1, archivedAt: 1, joinDate: -1 });
memberSchema.index({ tenantId: 1, userId: 1 });

export type MemberAttrs = InferSchemaType<typeof memberSchema> & { tenantId: Types.ObjectId };
export const Member = model('Member', memberSchema);
