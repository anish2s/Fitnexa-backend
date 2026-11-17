import { Schema, model, type Types } from 'mongoose';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * One visit. Tenant-scoped. `day` is the gym-local calendar date (YYYY-MM-DD), computed once at
 * check-in, so "today's attendance" never depends on the reader's time zone.
 * One check-in per member per day: enforced by the unique index, not by a read-then-write.
 */
export const CHECKIN_METHODS = ['qr', 'manual'] as const;

const attendanceSchema = new Schema(
  {
    memberId: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
    membershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    /** Gym-local hour 0–23, for the busy-hours report. */
    hour: { type: Number, required: true, min: 0, max: 23 },
    checkedInAt: { type: Date, required: true },
    method: { type: String, enum: CHECKIN_METHODS, required: true },
    recordedBy: { type: Schema.Types.ObjectId },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
attendanceSchema.plugin(tenantScopePlugin);
attendanceSchema.index({ tenantId: 1, memberId: 1, day: 1 }, { unique: true });
attendanceSchema.index({ tenantId: 1, day: 1, checkedInAt: 1 });

export type LeanAttendance = {
  _id: Types.ObjectId;
  memberId: Types.ObjectId;
  membershipId: Types.ObjectId;
  day: string;
  hour: number;
  checkedInAt: Date;
  method: 'qr' | 'manual';
  recordedBy?: Types.ObjectId | null;
};
export const Attendance = model('Attendance', attendanceSchema);
