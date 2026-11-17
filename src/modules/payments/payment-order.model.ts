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

/**
 * A captured Razorpay payment we did NOT apply, for the owner to act on. Today the only kind is a
 * second payment on an order that was already paid (member paid twice, two tabs, a retried UPI
 * intent): the money is with the gym's Razorpay account but must not extend or pay the membership
 * again. Nothing is refunded automatically; the owner refunds it in Razorpay and resolves the alert.
 */
export const GATEWAY_ALERT_STATUSES = ['duplicate_refund_due', 'resolved'] as const;
const gatewayAlertSchema = new Schema(
  {
    status: { type: String, enum: GATEWAY_ALERT_STATUSES, default: 'duplicate_refund_due' },
    razorpayOrderId: { type: String, required: true, maxlength: 64 },
    razorpayPaymentId: { type: String, required: true, maxlength: 64 },
    /** The payment that did pay the order. */
    appliedRazorpayPaymentId: { type: String, maxlength: 64 },
    amountPaise: { type: Number, required: true, min: 0 },
    membershipId: { type: Schema.Types.ObjectId, required: true },
    memberId: { type: Schema.Types.ObjectId, required: true },
    source: { type: String, enum: ['checkout', 'webhook'], required: true },
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId },
    resolutionNote: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);
gatewayAlertSchema.plugin(tenantScopePlugin);
// One alert per gateway payment, whether checkout or the webhook reports it first.
gatewayAlertSchema.index({ tenantId: 1, razorpayPaymentId: 1 }, { unique: true });
gatewayAlertSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export type LeanGatewayAlert = {
  _id: Types.ObjectId;
  status: (typeof GATEWAY_ALERT_STATUSES)[number];
  razorpayOrderId: string;
  razorpayPaymentId: string;
  appliedRazorpayPaymentId?: string | null;
  amountPaise: number;
  membershipId: Types.ObjectId;
  memberId: Types.ObjectId;
  source: 'checkout' | 'webhook';
  createdAt: Date;
  resolvedAt?: Date | null;
  resolvedBy?: Types.ObjectId | null;
  resolutionNote?: string | null;
};
export const GatewayAlert = model('GatewayAlert', gatewayAlertSchema);
