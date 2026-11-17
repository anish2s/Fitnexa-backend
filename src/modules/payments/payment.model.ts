import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { tenantScopePlugin } from '../../tenancy/tenant-scope.plugin.js';

/**
 * Money received for a membership. Tenant-scoped, never deleted. Refunds are recorded against the
 * payment (step 3), not by editing it.
 *
 * Every payment gets a receipt number from a per-gym, per-financial-year counter allocated inside
 * the same transaction, so numbers are unique and gap-free within a year.
 */
export const OFFLINE_METHODS = ['cash', 'upi', 'card', 'bank_transfer'] as const;
export const PAYMENT_METHODS = [...OFFLINE_METHODS, 'razorpay'] as const;

const paymentSchema = new Schema(
  {
    memberId: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
    membershipId: { type: Schema.Types.ObjectId, ref: 'Membership', required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    /** UPI transaction id, card approval code, bank reference… (optional, shown on the receipt). */
    reference: { type: String, trim: true, maxlength: 100 },
    receiptNumber: { type: String, required: true, maxlength: 40 },
    financialYear: { type: String, required: true, maxlength: 7 },
    receivedAt: { type: Date, required: true },
    receivedBy: { type: Schema.Types.ObjectId },
    notes: { type: String, maxlength: 500 },
    /** Client-chosen key making the request safe to retry (double taps, flaky networks). */
    idempotencyKey: { type: String, maxlength: 100 },
    /** Gateway payments only (Razorpay). */
    gateway: {
      provider: { type: String, enum: ['razorpay'] },
      orderId: { type: String, maxlength: 64 },
      paymentId: { type: String, maxlength: 64 },
    },
    /** Sum of refunds that are processed or pending (failed ones don't count). */
    refundedPaise: { type: Number, default: 0, min: 0 },
    refunds: {
      type: [
        new Schema(
          {
            refundNumber: { type: String, required: true, maxlength: 40 },
            amountPaise: { type: Number, required: true, min: 1 },
            /** How the money went back. Gateway refunds go back to the original method. */
            method: {
              type: String,
              enum: ['cash', 'upi', 'bank_transfer', 'gateway'],
              required: true,
            },
            reason: { type: String, required: true, maxlength: 500 },
            status: { type: String, enum: ['processed', 'pending', 'failed'], required: true },
            refundedAt: { type: Date, required: true },
            refundedBy: { type: Schema.Types.ObjectId },
            idempotencyKey: { type: String, maxlength: 100 },
            gatewayRefundId: { type: String, maxlength: 64 },
          },
          { _id: true },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);
paymentSchema.plugin(tenantScopePlugin);
paymentSchema.index({ tenantId: 1, receiptNumber: 1 }, { unique: true });
paymentSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
paymentSchema.index(
  { tenantId: 1, 'gateway.paymentId': 1 },
  { unique: true, partialFilterExpression: { 'gateway.paymentId': { $type: 'string' } } },
);
paymentSchema.index(
  { tenantId: 1, 'refunds.idempotencyKey': 1 },
  { unique: true, partialFilterExpression: { 'refunds.idempotencyKey': { $type: 'string' } } },
);
paymentSchema.index({ tenantId: 1, membershipId: 1, receivedAt: 1 });
paymentSchema.index({ tenantId: 1, memberId: 1, receivedAt: -1 });
paymentSchema.index({ tenantId: 1, receivedAt: -1 });
// Revenue report: refunds by the day they were made.
paymentSchema.index({ tenantId: 1, 'refunds.refundedAt': 1 });

export type PaymentAttrs = InferSchemaType<typeof paymentSchema> & { tenantId: Types.ObjectId };
export const Payment = model('Payment', paymentSchema);
