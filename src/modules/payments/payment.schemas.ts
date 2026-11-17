import { z } from 'zod';
import { objectId, pageQuery } from '../../lib/pagination.js';
import { OFFLINE_METHODS } from './payment.model.js';

const DAY = 86_400_000;

/** Offline payment as entered at the front desk. Razorpay payments arrive through the gateway. */
export const offlinePayment = z.object({
  amountPaise: z.number().int().min(1).max(1_00_00_000),
  method: z.enum(OFFLINE_METHODS),
  reference: z.string().trim().min(1).max(100).optional(),
  /** When the money was received; defaults to now. Up to 90 days back (late entry), not future. */
  receivedAt: z.coerce
    .date()
    .refine(
      (d) => d.getTime() <= Date.now() + 5 * 60_000 && d.getTime() >= Date.now() - 90 * DAY,
      'Received date must be within the last 90 days',
    )
    .optional(),
  notes: z.string().trim().max(500).optional(),
});
export type OfflinePaymentInput = z.infer<typeof offlinePayment>;

export const paymentIdParams = z.object({ id: objectId });

export const paymentListQuery = pageQuery.extend({
  /** Calendar dates in the gym's time zone, inclusive. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  method: z.enum(['cash', 'upi', 'card', 'bank_transfer', 'razorpay']).optional(),
  memberId: objectId.optional(),
});
export type PaymentListQuery = z.infer<typeof paymentListQuery>;

/** `Idempotency-Key` header: required on every request that records money. */
export const idempotencyKey = z
  .string({ message: 'Send an Idempotency-Key header (e.g. a UUID) with every payment' })
  .regex(/^[A-Za-z0-9_-]{8,100}$/, 'Idempotency-Key must be 8-100 letters, digits, _ or -');

export const refundBody = z.object({
  amountPaise: z.number().int().min(1).max(1_00_00_000),
  reason: z.string().trim().min(3).max(500),
  /** Desk refunds: how the money was handed back. Ignored for online payments (gateway refund). */
  method: z.enum(['cash', 'upi', 'bank_transfer']).optional(),
});
export type RefundInput = z.infer<typeof refundBody>;
