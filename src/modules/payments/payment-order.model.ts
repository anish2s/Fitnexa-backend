import { Schema, model, type Types } from 'mongoose';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * A Razorpay order we created for a membership balance. Tenant-scoped. The order fixes the amount;
 * a verified payment for it becomes a Payment row (method razorpay) exactly once.
 */
const paymentOrderSchema = new Schema(
  {
    membershipId: { type: Schema.Types.ObjectId, required: true },
    memberId: { type: Schema.Types.ObjectId, required: true },
    amountPaise: { type: Number, required: true, min: 100 },
    razorpayOrderId: { type: String, required: true, maxlength: 64 },
    status: { type: String, enum: ['created', 'paid'], default: 'created' },
    razorpayPaymentId: { type: String, maxlength: 64 },
    createdBy: { type: Schema.Types.ObjectId },
    createdVia: { type: String, enum: ['desk', 'member'], required: true },
  },
  { timestamps: true },
);
paymentOrderSchema.plugin(tenantScopePlugin);
paymentOrderSchema.index({ tenantId: 1, razorpayOrderId: 1 }, { unique: true });
paymentOrderSchema.index({ tenantId: 1, membershipId: 1, createdAt: -1 });

export type LeanPaymentOrder = {
  _id: Types.ObjectId;
  membershipId: Types.ObjectId;
  memberId: Types.ObjectId;
  amountPaise: number;
  razorpayOrderId: string;
  status: 'created' | 'paid';
  razorpayPaymentId?: string | null;
};
export const PaymentOrder = model('PaymentOrder', paymentOrderSchema);

/**
 * Webhook events already handled (Razorpay retries until it gets a 2xx). Kept 30 days.
 * The TTL index is single-field by necessity; the lookup index starts with tenantId.
 */
const webhookEventSchema = new Schema(
  {
    provider: { type: String, enum: ['razorpay'], required: true },
    eventId: { type: String, required: true, maxlength: 64 },
    event: { type: String, maxlength: 64 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
webhookEventSchema.plugin(tenantScopePlugin);
webhookEventSchema.index({ tenantId: 1, provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86_400 });
export const WebhookEvent = model('WebhookEvent', webhookEventSchema);
