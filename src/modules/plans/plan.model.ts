import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { GST_RATES, TAX_MODES } from '../../lib/money.js';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * A gym's membership plan (e.g. "Quarterly — 90 days — ₹4,500 incl. GST"). Tenant-scoped.
 * Plans are archived, never deleted: memberships keep a snapshot of the plan as sold anyway.
 */
const planSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 500 },
    durationDays: { type: Number, required: true, min: 1, max: 1095 },
    /** Integer paise. Meaning depends on taxMode (incl. or excl. GST). */
    pricePaise: { type: Number, required: true, min: 0, max: 1_00_00_000 },
    taxMode: { type: String, enum: TAX_MODES, required: true },
    gstRate: { type: Number, enum: GST_RATES, required: true },
    /** Lower-cased name, set by the service; uniqueness among live plans. */
    nameKey: { type: String, required: true, maxlength: 80 },
    /** Explicit null (not missing) so the partial unique index below can match live plans. */
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
planSchema.plugin(tenantScopePlugin);
planSchema.index({ tenantId: 1, archivedAt: 1, durationDays: 1 });
// Two live plans with the same name would be indistinguishable at the front desk.
planSchema.index(
  { tenantId: 1, nameKey: 1 },
  { unique: true, partialFilterExpression: { archivedAt: { $type: 'null' } } },
);

export type PlanAttrs = InferSchemaType<typeof planSchema> & { tenantId: Types.ObjectId };
export const Plan = model('Plan', planSchema);
