import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { GST_RATES, TAX_MODES } from '../../lib/money.js';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * One period of membership sold to a member. Tenant-scoped.
 *
 * The plan is copied in at sale time (`plan`), so later plan edits never change what was sold.
 * Status is NOT stored: upcoming / active / expired is derived from the dates against "today" in
 * the gym's time zone; only cancellation is recorded.
 */
export const MEMBERSHIP_KINDS = ['new', 'renewal'] as const;

const membershipSchema = new Schema(
  {
    memberId: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
    plan: {
      planId: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
      name: { type: String, required: true, maxlength: 80 },
      durationDays: { type: Number, required: true },
      pricePaise: { type: Number, required: true },
      taxMode: { type: String, enum: TAX_MODES, required: true },
      gstRate: { type: Number, enum: GST_RATES, required: true },
    },
    discountPaise: { type: Number, default: 0, min: 0 },
    basePaise: { type: Number, required: true, min: 0 },
    gstPaise: { type: Number, required: true, min: 0 },
    totalPaise: { type: Number, required: true, min: 0 },
    /** Calendar dates (UTC midnight), both inclusive. */
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    kind: { type: String, enum: MEMBERSHIP_KINDS, required: true },
    previousMembershipId: { type: Schema.Types.ObjectId },
    soldBy: { type: Schema.Types.ObjectId },
    notes: { type: String, maxlength: 500 },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId },
    cancelReason: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);
membershipSchema.plugin(tenantScopePlugin);
membershipSchema.index({ tenantId: 1, memberId: 1, startDate: -1 });
// "Expiring soon" / "active today" scans.
membershipSchema.index({ tenantId: 1, cancelledAt: 1, endDate: 1 });
membershipSchema.index({ tenantId: 1, 'plan.planId': 1 });

export type MembershipAttrs = InferSchemaType<typeof membershipSchema> & {
  tenantId: Types.ObjectId;
};
export const Membership = model('Membership', membershipSchema);
