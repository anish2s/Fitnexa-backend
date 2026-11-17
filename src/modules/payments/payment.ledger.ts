import { Types, type ClientSession } from 'mongoose';
import { financialYear, parseDateOnly, startOfDayIn, todayIn } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { requireTenantId } from '../../tenancy/context.js';
import { nextSequence } from '../counters/counter.model.js';
import { Membership } from '../memberships/membership.model.js';
import { Tenant } from '../tenants/tenant.model.js';
import { Payment } from './payment.model.js';

/**
 * The one place money is written. Always called inside a transaction, so the payment row, the
 * membership's paidPaise and the receipt counter commit together or not at all.
 */
export interface GymPaymentSettings {
  receiptPrefix: string;
  timezone: string;
}

export async function gymPaymentSettings(): Promise<GymPaymentSettings> {
  const t = await Tenant.findById(requireTenantId())
    .select('settings.receiptPrefix settings.timezone')
    .lean();
  return {
    receiptPrefix: t?.settings?.receiptPrefix ?? 'RCPT',
    timezone: t?.settings?.timezone ?? 'Asia/Kolkata',
  };
}

/** `[from, to]` gym-local calendar dates → UTC instants [start of from, start of day after to). */
export function localDateRange(from: string | undefined, to: string | undefined, tz: string) {
  const range: Record<string, Date> = {};
  if (from) range.$gte = startOfDayIn(from, tz);
  if (to) {
    const next = new Date(parseDateOnly(to)!.getTime() + 86_400_000).toISOString().slice(0, 10);
    range.$lt = startOfDayIn(next, tz);
  }
  return Object.keys(range).length ? range : undefined;
}

export interface NewPayment {
  membershipId: Types.ObjectId;
  memberId: Types.ObjectId;
  amountPaise: number;
  method: 'cash' | 'upi' | 'card' | 'bank_transfer' | 'razorpay';
  reference?: string;
  receivedAt: Date;
  notes?: string;
  idempotencyKey?: string;
  receivedBy?: string;
  gateway?: { provider: 'razorpay'; orderId: string; paymentId: string };
  /**
   * Desk payments may not exceed the balance. Gateway captures are recorded regardless: the money
   * has already been taken, and an overpayment must be visible (and refundable), not lost.
   */
  enforceBalance: boolean;
}

export async function insertPayment(
  session: ClientSession,
  p: NewPayment,
  settings: GymPaymentSettings,
) {
  const guard = p.enforceBalance
    ? { $expr: { $lte: [{ $add: ['$paidPaise', p.amountPaise] }, '$totalPaise'] } }
    : {};
  const updated = await Membership.updateOne(
    { _id: p.membershipId, ...(p.enforceBalance ? { cancelledAt: null } : {}), ...guard },
    { $inc: { paidPaise: p.amountPaise } },
    { session },
  );
  if (!updated.matchedCount) {
    throw Errors.validation([
      { path: 'amountPaise', message: 'Amount is more than the balance due' },
    ]);
  }

  const fy = financialYear(todayIn(settings.timezone, p.receivedAt));
  const seq = await nextSequence(`receipt:${fy}`, session);
  const id = new Types.ObjectId();
  await Payment.create(
    [
      {
        _id: id,
        memberId: p.memberId,
        membershipId: p.membershipId,
        amountPaise: p.amountPaise,
        method: p.method,
        reference: p.reference,
        receiptNumber: `${settings.receiptPrefix}/${fy}/${String(seq).padStart(4, '0')}`,
        financialYear: fy,
        receivedAt: p.receivedAt,
        receivedBy: p.receivedBy ? new Types.ObjectId(p.receivedBy) : undefined,
        notes: p.notes,
        idempotencyKey: p.idempotencyKey,
        gateway: p.gateway,
      },
    ],
    { session },
  );
  return id;
}

export function isDuplicateKey(err: unknown, field: string): boolean {
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  return e?.code === 11000 && Boolean(e.keyPattern && field in e.keyPattern);
}
