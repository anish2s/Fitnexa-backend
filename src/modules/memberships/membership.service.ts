import mongoose, { Types } from 'mongoose';
import { addDays, daysBetween, formatDateOnly, parseDateOnly, todayIn } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { priceBreakdown, type GST_RATES, type TaxMode } from '../../lib/money.js';

type GstRate = (typeof GST_RATES)[number];
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { requireTenantId } from '../../tenancy/context.js';
import type { AuditContext, AuditService } from '../audit/audit.service.js';
import { Member } from '../members/member.model.js';
import { Plan } from '../plans/plan.model.js';
import type { LeanPlan } from '../plans/plan.service.js';
import { Tenant } from '../tenants/tenant.model.js';
import { User } from '../users/user.model.js';
import { Membership } from './membership.model.js';
import type {
  ExpiringQuery,
  MembershipListQuery,
  RenewInput,
  SellInput,
} from './membership.schemas.js';

export type MembershipStatus = 'active' | 'upcoming' | 'expired' | 'cancelled';

export type LeanMembership = {
  _id: Types.ObjectId;
  memberId: Types.ObjectId;
  plan: {
    planId: Types.ObjectId;
    name: string;
    durationDays: number;
    pricePaise: number;
    taxMode: TaxMode;
    gstRate: number;
  };
  discountPaise: number;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  startDate: Date;
  endDate: Date;
  kind: 'new' | 'renewal';
  previousMembershipId?: Types.ObjectId | null;
  soldBy?: Types.ObjectId | null;
  notes?: string | null;
  cancelledAt?: Date | null;
  cancelReason?: string | null;
  createdAt?: Date;
};

export function statusOf(
  m: Pick<LeanMembership, 'startDate' | 'endDate' | 'cancelledAt'>,
  today: Date,
): MembershipStatus {
  if (m.cancelledAt) return 'cancelled';
  if (m.startDate > today) return 'upcoming';
  if (m.endDate < today) return 'expired';
  return 'active';
}

/** Mongo filter for a derived status, relative to the gym's today. */
export function statusFilter(status: MembershipStatus, today: Date): Record<string, unknown> {
  switch (status) {
    case 'cancelled':
      return { cancelledAt: { $ne: null } };
    case 'upcoming':
      return { cancelledAt: null, startDate: { $gt: today } };
    case 'expired':
      return { cancelledAt: null, endDate: { $lt: today } };
    default:
      return { cancelledAt: null, startDate: { $lte: today }, endDate: { $gte: today } };
  }
}

export function toMembershipView(
  m: LeanMembership,
  today: Date,
  opts: { forMember?: boolean } = {},
) {
  const status = statusOf(m, today);
  return {
    id: String(m._id),
    memberId: String(m.memberId),
    plan: {
      id: String(m.plan.planId),
      name: m.plan.name,
      durationDays: m.plan.durationDays,
      pricePaise: m.plan.pricePaise,
      taxMode: m.plan.taxMode,
      gstRate: m.plan.gstRate,
    },
    discountPaise: m.discountPaise,
    basePaise: m.basePaise,
    gstPaise: m.gstPaise,
    totalPaise: m.totalPaise,
    startDate: formatDateOnly(m.startDate),
    endDate: formatDateOnly(m.endDate),
    kind: m.kind,
    status,
    /** Days left including today (active), or until it starts (upcoming); null otherwise. */
    daysLeft:
      status === 'active'
        ? daysBetween(today, m.endDate) + 1
        : status === 'upcoming'
          ? daysBetween(today, m.startDate)
          : null,
    cancelledAt: m.cancelledAt ?? null,
    ...(opts.forMember
      ? {}
      : {
          cancelReason: m.cancelReason ?? null,
          notes: m.notes ?? null,
          soldBy: m.soldBy ? String(m.soldBy) : null,
          previousMembershipId: m.previousMembershipId ? String(m.previousMembershipId) : null,
          createdAt: m.createdAt ?? null,
        }),
  };
}
export type MembershipView = ReturnType<typeof toMembershipView>;

/** Today (UTC-midnight date) in the current gym's time zone, plus the gym settings we need. */
export async function gymCalendar() {
  const t = await Tenant.findById(requireTenantId())
    .select('settings.timezone settings.renewalReminderDays')
    .lean();
  return {
    today: parseDateOnly(todayIn(t?.settings?.timezone ?? 'Asia/Kolkata'))!,
    reminderDays: t?.settings?.renewalReminderDays ?? 7,
  };
}

/**
 * The member's current membership (active, else the next upcoming, else the latest expired), for
 * the member screen. Cancelled ones are skipped.
 */
export async function membershipSummary(memberId: Types.ObjectId | string, today: Date) {
  const rows = await Membership.find({ memberId, cancelledAt: null })
    .sort({ startDate: -1 })
    .limit(20)
    .lean<LeanMembership[]>();
  const active = rows.find((m) => statusOf(m, today) === 'active');
  const upcoming = rows.filter((m) => statusOf(m, today) === 'upcoming').at(-1);
  const pick = active ?? upcoming ?? rows[0];
  if (!pick) return { status: 'none' as const, current: null, nextStartDate: null };
  return {
    status: statusOf(pick, today),
    current: toMembershipView(pick, today),
    /** A renewal already queued after the active one. */
    nextStartDate: active && upcoming ? formatDateOnly(upcoming.startDate) : null,
  };
}

export function createMembershipService(deps: { audit: AuditService }) {
  const { audit } = deps;

  async function liveMember(id: string | Types.ObjectId) {
    const m = await Member.findById(id).select('name archivedAt').lean();
    if (!m) throw Errors.notFound('Member');
    if (m.archivedAt) throw Errors.conflict('Member is archived; restore them first');
    return m;
  }

  async function livePlan(id: string | Types.ObjectId) {
    const p = await Plan.findById(id).lean<LeanPlan>();
    if (!p) throw Errors.notFound('Plan');
    if (p.archivedAt) throw Errors.conflict('This plan is archived and can no longer be sold');
    return p;
  }

  async function latestOf(memberId: string | Types.ObjectId) {
    return Membership.findOne({ memberId, cancelledAt: null })
      .sort({ endDate: -1 })
      .lean<LeanMembership>();
  }

  /**
   * Creates one membership in a transaction that first writes the member document, so concurrent
   * sales for the same member are serialised and the overlap check sees the other's insert.
   */
  async function sell(
    memberId: string,
    args: {
      plan: LeanPlan;
      startDate: Date;
      discountPaise: number;
      notes?: string;
      kind: 'new' | 'renewal';
      previous?: LeanMembership | null;
    },
    ctx: AuditContext,
    today: Date,
  ) {
    const { plan, startDate } = args;
    if (args.discountPaise > plan.pricePaise) {
      throw Errors.validation([
        { path: 'discountPaise', message: 'Discount is more than the price' },
      ]);
    }
    const endDate = addDays(startDate, plan.durationDays - 1);
    const money = priceBreakdown(plan.pricePaise, plan.taxMode, plan.gstRate, args.discountPaise);
    const id = new Types.ObjectId();

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Member.updateOne({ _id: memberId }, { $inc: { membershipRev: 1 } }, { session });
        const clash = await Membership.findOne({
          memberId,
          cancelledAt: null,
          startDate: { $lte: endDate },
          endDate: { $gte: startDate },
        })
          .session(session)
          .lean<LeanMembership>();
        if (clash) {
          throw Errors.conflict('Overlaps an existing membership', {
            membershipId: String(clash._id),
            startDate: formatDateOnly(clash.startDate),
            endDate: formatDateOnly(clash.endDate),
            /** The first day a new membership could start. */
            availableFrom: formatDateOnly(addDays(clash.endDate, 1)),
          });
        }
        await Membership.create(
          [
            {
              _id: id,
              memberId,
              plan: {
                planId: plan._id,
                name: plan.name,
                durationDays: plan.durationDays,
                pricePaise: plan.pricePaise,
                taxMode: plan.taxMode,
                gstRate: plan.gstRate as GstRate,
              },
              discountPaise: args.discountPaise,
              ...money,
              startDate,
              endDate,
              kind: args.kind,
              previousMembershipId: args.previous?._id,
              soldBy: ctx.actor.id ? new Types.ObjectId(ctx.actor.id) : undefined,
              notes: args.notes,
            },
          ],
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    await audit.record(ctx, {
      action: args.kind === 'renewal' ? 'membership.renew' : 'membership.create',
      target: { type: 'membership', id: String(id) },
      metadata: {
        memberId,
        plan: plan.name,
        startDate: formatDateOnly(startDate),
        endDate: formatDateOnly(endDate),
        totalPaise: money.totalPaise,
        discountPaise: args.discountPaise,
      },
    });
    const created = await Membership.findById(id).lean<LeanMembership>();
    return toMembershipView(created!, today);
  }

  async function create(memberId: string, input: SellInput, ctx: AuditContext) {
    const { today } = await gymCalendar();
    await liveMember(memberId);
    const plan = await livePlan(input.planId);
    const hadAny = await Membership.exists({ memberId, cancelledAt: null });
    return sell(
      memberId,
      {
        plan,
        startDate: input.startDate ?? today,
        discountPaise: input.discountPaise ?? 0,
        notes: input.notes,
        kind: hadAny ? 'renewal' : 'new',
      },
      ctx,
      today,
    );
  }

  async function renew(memberId: string, input: RenewInput, ctx: AuditContext) {
    const { today } = await gymCalendar();
    await liveMember(memberId);
    const latest = await latestOf(memberId);
    if (!latest && !input.planId) {
      throw Errors.validation([
        { path: 'planId', message: 'No previous membership: choose a plan' },
      ]);
    }
    const startFrom = input.startFrom ?? (latest && latest.endDate >= today ? 'expiry' : 'today');
    if (startFrom === 'expiry' && !latest) {
      throw Errors.conflict('No previous membership to renew from; start from today');
    }
    const plan = await livePlan(input.planId ?? latest!.plan.planId);
    return sell(
      memberId,
      {
        plan,
        startDate: startFrom === 'expiry' ? addDays(latest!.endDate, 1) : today,
        discountPaise: input.discountPaise ?? 0,
        notes: input.notes,
        kind: latest ? 'renewal' : 'new',
        previous: latest,
      },
      ctx,
      today,
    );
  }

  async function cancel(id: string, reason: string, ctx: AuditContext) {
    const { today } = await gymCalendar();
    const m = await Membership.findById(id).lean<LeanMembership>();
    if (!m) throw Errors.notFound('Membership');
    const status = statusOf(m, today);
    if (status === 'cancelled' || status === 'expired') {
      throw Errors.conflict(`Membership is already ${status}`);
    }
    const after = await Membership.findOneAndUpdate(
      { _id: id, cancelledAt: null },
      {
        $set: {
          cancelledAt: new Date(),
          cancelReason: reason,
          cancelledBy: ctx.actor.id ? new Types.ObjectId(ctx.actor.id) : undefined,
        },
      },
      { returnDocument: 'after' },
    ).lean<LeanMembership>();
    if (!after) throw Errors.conflict('Membership was changed, try again');
    await audit.record(ctx, {
      action: 'membership.cancel',
      target: { type: 'membership', id },
      metadata: { memberId: String(m.memberId), reason, status },
    });
    return toMembershipView(after, today);
  }

  async function history(memberId: string) {
    const { today } = await gymCalendar();
    if (!(await Member.exists({ _id: memberId }))) throw Errors.notFound('Member');
    const rows = await Membership.find({ memberId })
      .sort({ startDate: -1, _id: -1 })
      .limit(200)
      .lean<LeanMembership[]>();
    return {
      summary: await membershipSummary(memberId, today),
      items: rows.map((m) => toMembershipView(m, today)),
    };
  }

  async function selfHistory(userId: string) {
    const { today } = await gymCalendar();
    const user = await User.findOne({ _id: userId, role: 'member' }).select('memberId').lean();
    if (!user?.memberId) throw Errors.notFound('Member profile');
    const rows = await Membership.find({ memberId: user.memberId })
      .sort({ startDate: -1, _id: -1 })
      .limit(200)
      .lean<LeanMembership[]>();
    const summary = await membershipSummary(user.memberId, today);
    return {
      summary: {
        status: summary.status,
        current: summary.current
          ? toMembershipView(
              rows.find((r) => String(r._id) === summary.current!.id)!,
              today,
              { forMember: true },
            )
          : null,
        nextStartDate: summary.nextStartDate,
      },
      items: rows.map((m) => toMembershipView(m, today, { forMember: true })),
    };
  }

  /** Attaches member names/codes/phones for gym-wide lists. */
  async function withMembers(rows: LeanMembership[], today: Date) {
    const members = await Member.find({ _id: { $in: rows.map((r) => r.memberId) } })
      .select('memberCode name phone photoUrl archivedAt')
      .lean();
    const byId = new Map(members.map((m) => [String(m._id), m]));
    return rows.map((r) => {
      const m = byId.get(String(r.memberId));
      return {
        ...toMembershipView(r, today),
        member: m
          ? {
              id: String(m._id),
              memberCode: m.memberCode,
              name: m.name,
              phone: m.phone,
              photoUrl: m.photoUrl ?? null,
              archived: Boolean(m.archivedAt),
            }
          : null,
      };
    });
  }

  async function list(q: MembershipListQuery) {
    const { today } = await gymCalendar();
    const filter: Record<string, unknown> = q.status ? statusFilter(q.status, today) : {};
    if (q.planId) filter['plan.planId'] = new Types.ObjectId(q.planId);
    const [rows, total] = await Promise.all([
      Membership.find(filter)
        .sort({ endDate: 1, _id: 1 })
        .skip(skipFor(q))
        .limit(q.limit)
        .lean<LeanMembership[]>(),
      Membership.countDocuments(filter),
    ]);
    return { items: await withMembers(rows, today), meta: pageMeta(q, total) };
  }

  /**
   * Active memberships ending within `days` (today included) whose member has NOT already renewed
   * (no later, non-cancelled membership) and isn't archived. Soonest first.
   */
  async function expiring(q: ExpiringQuery) {
    const { today, reminderDays } = await gymCalendar();
    const days = q.days ?? reminderDays;
    const until = addDays(today, days);
    const pipeline = [
      {
        $match: {
          cancelledAt: null,
          startDate: { $lte: today },
          endDate: { $gte: today, $lte: until },
        },
      },
      {
        $lookup: {
          from: Membership.collection.collectionName,
          let: { mid: '$memberId', end: '$endDate', tid: '$tenantId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$tenantId', '$$tid'] },
                    { $eq: ['$memberId', '$$mid'] },
                    { $eq: ['$cancelledAt', null] },
                    { $gt: ['$startDate', '$$end'] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: 'later',
        },
      },
      { $match: { later: { $size: 0 } } },
      {
        $lookup: {
          from: Member.collection.collectionName,
          let: { mid: '$memberId', tid: '$tenantId' },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $eq: ['$_id', '$$mid'] }, { $eq: ['$tenantId', '$$tid'] }] },
              },
            },
            { $project: { archivedAt: 1 } },
          ],
          as: 'member',
        },
      },
      { $match: { 'member.archivedAt': null } },
      { $sort: { endDate: 1 as const, _id: 1 as const } },
      {
        $facet: {
          rows: [{ $skip: skipFor(q) }, { $limit: q.limit }, { $project: { later: 0, member: 0 } }],
          total: [{ $count: 'n' }],
        },
      },
    ];
    const [out] = await Membership.aggregate<{ rows: LeanMembership[]; total: { n: number }[] }>(
      pipeline,
    );
    const total = out?.total[0]?.n ?? 0;
    return {
      items: await withMembers(out?.rows ?? [], today),
      meta: { ...pageMeta(q, total), days, until: formatDateOnly(until) },
    };
  }

  return { create, renew, cancel, history, selfHistory, list, expiring };
}

export type MembershipService = ReturnType<typeof createMembershipService>;
