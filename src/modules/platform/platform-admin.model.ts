import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Super admins (you). Deliberately NOT tenant-scoped and NOT in `users`, so a gym query can never
 * return one, and a super admin can only authenticate on the platform host.
 * Created/reset with `npm run admin:create`; there is no self-service reset for this role.
 */
const platformAdminSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      unique: true,
    },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    lastLoginAt: { type: Date },
    failedLogins: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, select: false },
    passwordChangedAt: { type: Date },
  },
  { timestamps: true },
);

export type PlatformAdminAttrs = InferSchemaType<typeof platformAdminSchema>;
export const PlatformAdmin = model('PlatformAdmin', platformAdminSchema);
