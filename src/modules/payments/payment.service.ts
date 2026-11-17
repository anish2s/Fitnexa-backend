import mongoose, { Types } from 'mongoose';
import { Errors } from '../../lib/errors.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import type { AuditContext, AuditService } from '../audit/audit.service.js';
import { Member } from '../members/member.model.js';
import { Membership } from '../memberships/membership.model.js';
import {
  gymCalendar,
  toMembershipView,
  type LeanMembership,
} from '../memberships/membership.service.js';
import { Tenant } from '../tenants/tenant.model.js';
import { User } from '../users/user.model.js';
import { requireTenantId } from '../../tenancy/context.js';
import { renderReceiptPdf, type ReceiptData } from './receipt.pdf.js';
import {
  gymPaymentSettings,
  insertPayment,
  isDuplicateKey,
  localDateRange,
} from './payment.ledger.js';
import { Payment } from './payment.model.js';
import { assertSameRequest, toPaymentView, type LeanPayment } from './payment.view.js';
import type { OfflinePaymentInput, PaymentListQuery } from './payment.schemas.js';

export function createPaymentService(deps: { audit: AuditService }) {
  const { audit } = deps;

  async function withMembership(p: LeanPayment) {
    const { today } = await gymCalendar();
    const m = await Membership.findById(p.membershipId).lean<LeanMembership>();
    return { ...toPaymentView(p), membership: m ? toMembershipView(m, today) : null };
  }

  /** Records a front-desk payment against a membership. Returns { replayed } for 200 vs 201. */
  async function record(
    membershipId: string,
    input: OfflinePaymentInput,
    key: string,
    ctx: AuditContext,
  ) {
    const prior = await Payment.findOne({ idempotencyKey: key }).lean<LeanPayment>();
    if (prior) {
      assertSameRequest(prior, {
        membershipId,
        amountPaise: input.amountPaise,
        method: input.method,
      });
      return { payment: await withMembership(prior), replayed: true };
    }

    const m = await Membership.findById(membershipId).lean<
      LeanMembership & { paidPaise?: number }
    >();
    if (!m) throw Errors.notFound('Membership');
    if (m.cancelledAt)
      throw Errors.conflict('Membership is cancelled; refund instead of collecting');
    const balance = m.totalPaise - (m.paidPaise ?? 0);
    if (input.amountPaise > balance) {
      throw Errors.validation([
        { path: 'amountPaise', message: `Amount is more than the balance due (${balance} paise)` },
      ]);
    }

    const settings = await gymPaymentSettings();
    const session = await mongoose.startSession();
    let id: Types.ObjectId;
    try {
      await session.withTransaction(async () => {
        id = await insertPayment(
          session,
          {
            membershipId: m._id,
            memberId: m.memberId,
            amountPaise: input.amountPaise,
            method: input.method,
            reference: input.reference,
            receivedAt: input.receivedAt ?? new Date(),
            notes: input.notes,
            idempotencyKey: key,
            receivedBy: ctx.actor.id,
            enforceBalance: true,
          },
          settings,
        );
      });
    } catch (err) {
      // Same key raced in from a parallel request: the other one won; answer with its result.
      if (isDuplicateKey(err, 'idempotencyKey')) return record(membershipId, input, key, ctx);
      throw err;
    } finally {
      await session.endSession();
    }

    const payment = await Payment.findById(id!).lean<LeanPayment>();
    await audit.record(ctx, {
      action: 'payment.record',
      target: { type: 'payment', id: String(id!) },
      metadata: {
        receiptNumber: payment!.receiptNumber,
        amountPaise: payment!.amountPaise,
        method: payment!.method,
        membershipId,
      },
    });
    return { payment: await withMembership(payment!), replayed: false };
  }

  async function get(id: string) {
    const p = await Payment.findById(id).lean<LeanPayment>();
    if (!p) throw Errors.notFound('Payment');
    return withMembership(p);
  }

  async function list(q: PaymentListQuery) {
    const settings = await gymPaymentSettings();
    const filter: Record<string, unknown> = {};
    const range = localDateRange(q.from, q.to, settings.timezone);
    if (range) filter.receivedAt = range;
    if (q.method) filter.method = q.method;
    if (q.memberId) filter.memberId = new Types.ObjectId(q.memberId);
    const [rows, total, sums] = await Promise.all([
      Payment.find(filter)
        .sort({ receivedAt: -1, _id: -1 })
        .skip(skipFor(q))
        .limit(q.limit)
        .lean<LeanPayment[]>(),
      Payment.countDocuments(filter),
      Payment.aggregate<{ amount: number; refunded: number }>([
        { $match: filter },
        {
          $group: {
            _id: null,
            amount: { $sum: '$amountPaise' },
            refunded: { $sum: '$refundedPaise' },
          },
        },
      ]),
    ]);
    const members = await Member.find({ _id: { $in: rows.map((r) => r.memberId) } })
      .select('memberCode name phone')
      .lean();
    const byId = new Map(members.map((m) => [String(m._id), m]));
    const items = rows.map((p) => {
      const m = byId.get(String(p.memberId));
      return {
        ...toPaymentView(p),
        member: m
          ? { id: String(m._id), memberCode: m.memberCode, name: m.name, phone: m.phone }
          : null,
      };
    });
    const s = sums[0] ?? { amount: 0, refunded: 0 };
    return {
      items,
      meta: {
        ...pageMeta(q, total),
        /** Over the whole filter, not just this page. */
        totals: {
          receivedPaise: s.amount,
          refundedPaise: s.refunded,
          netPaise: s.amount - s.refunded,
        },
      },
    };
  }

  async function forMember(memberId: string) {
    if (!(await Member.exists({ _id: memberId }))) throw Errors.notFound('Member');
    const rows = await Payment.find({ memberId })
      .sort({ receivedAt: -1 })
      .limit(500)
      .lean<LeanPayment[]>();
    return rows.map((p) => toPaymentView(p));
  }

  async function selfPayments(userId: string) {
    const user = await User.findOne({ _id: userId, role: 'member' }).select('memberId').lean();
    if (!user?.memberId) throw Errors.notFound('Member profile');
    const rows = await Payment.find({ memberId: user.memberId })
      .sort({ receivedAt: -1 })
      .limit(500)
      .lean<LeanPayment[]>();
    return rows.map((p) => toPaymentView(p, { forMember: true }));
  }

  /** Everything the receipt needs, read inside the gym's scope. */
  async function receiptData(p: LeanPayment): Promise<ReceiptData> {
    const [gym, member, ms] = await Promise.all([
      Tenant.findById(requireTenantId()).lean(),
      Member.findById(p.memberId).select('name memberCode phone').lean(),
      Membership.findById(p.membershipId).lean<LeanMembership>(),
    ]);
    if (!gym || !member || !ms) throw Errors.notFound('Payment');
    const tz = gym.settings?.timezone ?? 'Asia/Kolkata';
    const when = new Intl.DateTimeFormat('en-IN', {
      timeZone: tz,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(p.receivedAt);
    const day = (d: Date) =>
      new Intl.DateTimeFormat('en-IN', {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(d);
    const a = gym.address ?? {};
    return {
      gym: {
        name: gym.name,
        address: [
          [a.line1, a.line2].filter(Boolean).join(', '),
          [a.city, a.state, a.postalCode].filter(Boolean).join(', '),
        ].filter(Boolean),
        phone: gym.phone,
        email: gym.email,
        gstin: gym.settings?.gstin,
      },
      receiptNumber: p.receiptNumber,
      receivedAtText: when,
      member: { name: member.name, memberCode: member.memberCode, phone: member.phone },
      membership: {
        planName: ms.plan.name,
        periodText: `${day(ms.startDate)} to ${day(ms.endDate)}`,
        pricePaise: ms.plan.pricePaise,
        discountPaise: ms.discountPaise,
        basePaise: ms.basePaise,
        gstPaise: ms.gstPaise,
        gstRate: ms.plan.gstRate,
        totalPaise: ms.totalPaise,
        paidPaise: ms.paidPaise ?? 0,
      },
      payment: {
        amountPaise: p.amountPaise,
        method: p.method,
        reference: p.reference,
        refundedPaise: p.refundedPaise ?? 0,
      },
    };
  }

  async function receipt(id: string) {
    const p = await Payment.findById(id).lean<LeanPayment>();
    if (!p) throw Errors.notFound('Payment');
    return { receiptNumber: p.receiptNumber, pdf: await renderReceiptPdf(await receiptData(p)) };
  }

  /** A member's own receipt: the payment must belong to the signed-in member. */
  async function selfReceipt(userId: string, id: string) {
    const user = await User.findOne({ _id: userId, role: 'member' }).select('memberId').lean();
    const p = user?.memberId
      ? await Payment.findOne({ _id: id, memberId: user.memberId }).lean<LeanPayment>()
      : null;
    if (!p) throw Errors.notFound('Payment');
    return { receiptNumber: p.receiptNumber, pdf: await renderReceiptPdf(await receiptData(p)) };
  }

  return { record, get, list, forMember, selfPayments, receipt, selfReceipt };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
