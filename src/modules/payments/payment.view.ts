import type { Types } from 'mongoose';
import { Errors } from '../../lib/errors.js';

export type LeanPayment = {
  _id: Types.ObjectId;
  memberId: Types.ObjectId;
  membershipId: Types.ObjectId;
  amountPaise: number;
  method: string;
  reference?: string | null;
  receiptNumber: string;
  financialYear: string;
  receivedAt: Date;
  receivedBy?: Types.ObjectId | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  gateway?: { provider?: string; orderId?: string; paymentId?: string } | null;
  refundedPaise?: number;
  createdAt?: Date;
};

export function toPaymentView(p: LeanPayment, opts: { forMember?: boolean } = {}) {
  return {
    id: String(p._id),
    receiptNumber: p.receiptNumber,
    financialYear: p.financialYear,
    memberId: String(p.memberId),
    membershipId: String(p.membershipId),
    amountPaise: p.amountPaise,
    refundedPaise: p.refundedPaise ?? 0,
    method: p.method,
    reference: p.reference ?? null,
    receivedAt: p.receivedAt,
    ...(opts.forMember
      ? {}
      : {
          receivedBy: p.receivedBy ? String(p.receivedBy) : null,
          notes: p.notes ?? null,
          gateway: p.gateway?.paymentId
            ? {
                provider: p.gateway.provider,
                orderId: p.gateway.orderId,
                paymentId: p.gateway.paymentId,
              }
            : null,
          createdAt: p.createdAt ?? null,
        }),
  };
}

/**
 * Replaying an Idempotency-Key returns the original payment. Reusing a key for a DIFFERENT
 * payment is a client bug and is refused, never silently merged.
 */
export function assertSameRequest(
  existing: LeanPayment,
  expected: { membershipId?: string; memberId?: string; amountPaise: number; method: string },
) {
  const same =
    existing.amountPaise === expected.amountPaise &&
    existing.method === expected.method &&
    (!expected.membershipId || String(existing.membershipId) === expected.membershipId) &&
    (!expected.memberId || String(existing.memberId) === expected.memberId);
  if (!same) {
    throw Errors.conflict('This Idempotency-Key was already used for a different payment', {
      paymentId: String(existing._id),
    });
  }
}
