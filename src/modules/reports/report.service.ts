import {
  addDays,
  daysBetween,
  formatDateOnly,
  parseDateOnly,
  startOfDayIn,
  todayIn,
} from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { requireTenantId } from '../../tenancy/context.js';
import { Attendance } from '../attendance/attendance.model.js';
import { Member } from '../members/member.model.js';
import { Membership } from '../memberships/membership.model.js';
import { nextAfter, unrenewedEnding, type MsRow } from '../memberships/renewal-status.js';
import { Payment } from '../payments/payment.model.js';
import { GatewayAlert } from '../payments/payment-order.model.js';
import { Tenant } from '../tenants/tenant.model.js';
import {
  MAX_RANGE_DAYS,
  bucketEnd,
  daysIn,
  defaultGroupBy,
  fold,
  type GroupBy,
} from './periods.js';
import type { RangeQuery } from './report.schemas.js';

const nextDay = (d: string) => formatDateOnly(addDays(parseDateOnly(d)!, 1))!;
const shift = (d: string, n: number) => formatDateOnly(addDays(parseDateOnly(d)!, n))!;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

async function gym() {
  const t = await Tenant.findById(requireTenantId())
    .select('settings.timezone settings.renewalReminderDays')
    .lean();
  const tz = t?.settings?.timezone ?? 'Asia/Kolkata';
  return { tz, today: todayIn(tz), reminderDays: t?.settings?.renewalReminderDays ?? 7 };
}

/** Validated [from, to] with defaults (last 30 days) and grouping. */
function resolveRange(q: RangeQuery, today: string) {
  const to = q.to ?? today;
  const from = q.from ?? shift(to, -29);
  if (!parseDateOnly(from) || !parseDateOnly(to)) {
    throw Errors.validation([{ path: 'from', message: 'Not a real date' }]);
  }
  if (from > to)
    throw Errors.validation([{ path: 'from', message: '"from" must not be after "to"' }]);
  if (daysBetween(parseDateOnly(from)!, parseDateOnly(to)!) + 1 > MAX_RANGE_DAYS) {
    throw Errors.validation([{ path: 'to', message: `At most ${MAX_RANGE_DAYS} days per report` }]);
  }
  const groupBy: GroupBy = q.groupBy ?? defaultGroupBy(from, to);
  return { from, to, groupBy };
}

/** UTC instants for gym-local [from 00:00, day after `to` 00:00). */
const instantRange = (from: string, to: string, tz: string) => ({
  $gte: startOfDayIn(from, tz),
  $lt: startOfDayIn(nextDay(to), tz),
});
const localDay = (field: string, tz: string) => ({
  $dateToString: { format: '%Y-%m-%d', date: field, timezone: tz },
});

export function createReportService() {
  // ---------------------------------------------------------------- shared aggregates

  async function receiptsPerDay(from: string, to: string, tz: string) {
    const rows = await Payment.aggregate<{ _id: string; amount: number; n: number }>([
      { $match: { receivedAt: instantRange(from, to, tz) } },
      {
        $group: {
          _id: localDay('$receivedAt', tz),
          amount: { $sum: '$amountPaise' },
          n: { $sum: 1 },
        },
      },
    ]);
    return new Map(rows.map((r) => [r._id, { receivedPaise: r.amount, payments: r.n }]));
  }

  /** Refunds by the day they were made (failed ones never left the gym). */
  async function refundsPerDay(from: string, to: string, tz: string) {
    const rows = await Payment.aggregate<{ _id: string; amount: number; n: number }>([
      { $match: { 'refunds.refundedAt': instantRange(from, to, tz) } },
      { $unwind: '$refunds' },
      {
        $match: {
          'refunds.refundedAt': instantRange(from, to, tz),
          'refunds.status': { $ne: 'failed' },
        },
      },
      {
        $group: {
          _id: localDay('$refunds.refundedAt', tz),
          amount: { $sum: '$refunds.amountPaise' },
          n: { $sum: 1 },
        },
      },
    ]);
    return new Map(rows.map((r) => [r._id, { refundedPaise: r.amount, refunds: r.n }]));
  }

  async function netRevenue(from: string, to: string, tz: string) {
    const [rec, ref] = await Promise.all([
      receiptsPerDay(from, to, tz),
      refundsPerDay(from, to, tz),
    ]);
    const received = [...rec.values()].reduce((a, v) => a + v.receivedPaise, 0);
    const refunded = [...ref.values()].reduce((a, v) => a + v.refundedPaise, 0);
    return { receivedPaise: received, refundedPaise: refunded, netPaise: received - refunded };
  }

  async function activeMemberIds(onDay: Date) {
    const ids = await Membership.distinct('memberId', {
      cancelledAt: null,
      startDate: { $lte: onDay },
      endDate: { $gte: onDay },
    });
    return Member.distinct('_id', { _id: { $in: ids }, archivedAt: null });
  }

  // ---------------------------------------------------------------- dashboard

  /**
   * KPIs for the home screen. `revenue` only when the caller may see reports; `alerts` only when
   * they may refund (the alerts are refunds owed).
   */
  async function dashboard(opts: { includeRevenue: boolean; includeAlerts: boolean }) {
    const { tz, today, reminderDays } = await gym();
    const todayDate = parseDateOnly(today)!;
    const monthStart = `${today.slice(0, 7)}-01`;
    const lastMonthEnd = shift(monthStart, -1);
    const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;

    const [totalMembers, active, newThisMonth, checkInsToday, expiring, lapsed, dues] =
      await Promise.all([
        Member.countDocuments({ archivedAt: null }),
        activeMemberIds(todayDate),
        Member.countDocuments({ joinDate: { $gte: parseDateOnly(monthStart)!, $lte: todayDate } }),
        Attendance.countDocuments({ day: today }),
        unrenewedEnding(today, shift(today, reminderDays)),
        unrenewedEnding(shift(today, -30), shift(today, -1)),
        Membership.aggregate<{ amount: number; n: number }>([
          { $match: { cancelledAt: null, $expr: { $gt: ['$totalPaise', '$paidPaise'] } } },
          {
            $group: {
              _id: null,
              amount: { $sum: { $subtract: ['$totalPaise', '$paidPaise'] } },
              n: { $sum: 1 },
            },
          },
        ]),
      ]);
    const activeCount = active.length;
    return {
      date: today,
      members: { total: totalMembers, active: activeCount, newThisMonth },
      attendanceToday: {
        checkIns: checkInsToday,
        rate: activeCount ? Math.round((checkInsToday / activeCount) * 100) / 100 : null,
      },
      pendingRenewals: {
        /** Ending within the gym's reminder window and not renewed yet. */
        expiringSoon: expiring.length,
        windowDays: reminderDays,
        /** Ended in the last 30 days without a renewal. */
        recentlyLapsed: lapsed.length,
      },
      dues: { outstandingPaise: dues[0]?.amount ?? 0, memberships: dues[0]?.n ?? 0 },
      alerts: opts.includeAlerts
        ? {
            /** Second online payments on already-paid orders: refund in Razorpay, then resolve. */
            duplicatePaymentsRefundDue: await GatewayAlert.countDocuments({
              status: 'duplicate_refund_due',
            }),
          }
        : null,
      revenue: opts.includeRevenue
        ? {
            thisMonth: {
              from: monthStart,
              to: today,
              ...(await netRevenue(monthStart, today, tz)),
            },
            lastMonth: {
              from: lastMonthStart,
              to: lastMonthEnd,
              ...(await netRevenue(lastMonthStart, lastMonthEnd, tz)),
            },
          }
        : null,
    };
  }

  // ---------------------------------------------------------------- reports

  async function revenue(q: RangeQuery) {
    const { tz, today } = await gym();
    const { from, to, groupBy } = resolveRange(q, today);
    const [rec, ref, byMethodRows] = await Promise.all([
      receiptsPerDay(from, to, tz),
      refundsPerDay(from, to, tz),
      Payment.aggregate<{ _id: string; amount: number; n: number }>([
        { $match: { receivedAt: instantRange(from, to, tz) } },
        { $group: { _id: '$method', amount: { $sum: '$amountPaise' }, n: { $sum: 1 } } },
      ]),
    ]);
    const perDay = new Map<
      string,
      { receivedPaise: number; refundedPaise: number; payments: number; refunds: number }
    >();
    for (const d of new Set([...rec.keys(), ...ref.keys()])) {
      perDay.set(d, {
        receivedPaise: rec.get(d)?.receivedPaise ?? 0,
        payments: rec.get(d)?.payments ?? 0,
        refundedPaise: ref.get(d)?.refundedPaise ?? 0,
        refunds: ref.get(d)?.refunds ?? 0,
      });
    }
    const zero = () => ({ receivedPaise: 0, refundedPaise: 0, payments: 0, refunds: 0 });
    const series = fold(perDay, from, to, groupBy, zero).map(({ period, values }) => ({
      period,
      ...values,
      netPaise: values.receivedPaise - values.refundedPaise,
    }));
    const totals = series.reduce((a, r) => {
      a.receivedPaise += r.receivedPaise;
      a.refundedPaise += r.refundedPaise;
      a.payments += r.payments;
      a.refunds += r.refunds;
      return a;
    }, zero());
    return {
      from,
      to,
      groupBy,
      series,
      totals: { ...totals, netPaise: totals.receivedPaise - totals.refundedPaise },
      byMethod: Object.fromEntries(
        byMethodRows.map((r) => [r._id, { receivedPaise: r.amount, payments: r.n }]),
      ),
    };
  }

  async function memberships(q: RangeQuery) {
    const { tz, today } = await gym();
    const { from, to, groupBy } = resolveRange(q, today);
    const range = instantRange(from, to, tz);
    const [sold, byPlan, cancelled] = await Promise.all([
      Membership.aggregate<{
        _id: { day: string; kind: string };
        n: number;
        value: number;
        discount: number;
      }>([
        { $match: { createdAt: range } },
        {
          $group: {
            _id: { day: localDay('$createdAt', tz), kind: '$kind' },
            n: { $sum: 1 },
            value: { $sum: '$totalPaise' },
            discount: { $sum: '$discountPaise' },
          },
        },
      ]),
      Membership.aggregate<{ _id: string; n: number; value: number }>([
        { $match: { createdAt: range } },
        { $group: { _id: '$plan.name', n: { $sum: 1 }, value: { $sum: '$totalPaise' } } },
        { $sort: { value: -1 } },
      ]),
      Membership.aggregate<{ _id: string; n: number }>([
        { $match: { cancelledAt: range } },
        { $group: { _id: localDay('$cancelledAt', tz), n: { $sum: 1 } } },
      ]),
    ]);
    type Row = {
      sold: number;
      new: number;
      renewals: number;
      valuePaise: number;
      discountPaise: number;
      cancelled: number;
    };
    const zero = (): Row => ({
      sold: 0,
      new: 0,
      renewals: 0,
      valuePaise: 0,
      discountPaise: 0,
      cancelled: 0,
    });
    const perDay = new Map<string, Row>();
    const at = (d: string) => perDay.get(d) ?? (perDay.set(d, zero()), perDay.get(d)!);
    for (const r of sold) {
      const row = at(r._id.day);
      row.sold += r.n;
      row[r._id.kind === 'renewal' ? 'renewals' : 'new'] += r.n;
      row.valuePaise += r.value;
      row.discountPaise += r.discount;
    }
    for (const c of cancelled) at(c._id).cancelled += c.n;
    const series = fold(perDay, from, to, groupBy, zero).map(({ period, values }) => ({
      period,
      ...values,
    }));
    const totals = series.reduce((a, r) => {
      for (const k of Object.keys(a) as (keyof Row)[]) a[k] += r[k];
      return a;
    }, zero());
    return {
      from,
      to,
      groupBy,
      series,
      totals,
      byPlan: byPlan.map((p) => ({ plan: p._id, sold: p.n, valuePaise: p.value })),
    };
  }

  async function attendance(q: RangeQuery) {
    const { today } = await gym();
    const { from, to, groupBy } = resolveRange(q, today);
    const match = { day: { $gte: from, $lte: to } };
    const [perDayRows, unique, byHourRows] = await Promise.all([
      Attendance.aggregate<{ _id: string; n: number }>([
        { $match: match },
        { $group: { _id: '$day', n: { $sum: 1 } } },
      ]),
      Attendance.distinct('memberId', match),
      Attendance.aggregate<{ _id: number; n: number }>([
        { $match: match },
        { $group: { _id: '$hour', n: { $sum: 1 } } },
      ]),
    ]);
    const perDay = new Map(perDayRows.map((r) => [r._id, { checkIns: r.n }]));
    const series = fold(perDay, from, to, groupBy, () => ({ checkIns: 0 })).map(
      ({ period, values }) => ({ period, ...values }),
    );
    const total = series.reduce((a, r) => a + r.checkIns, 0);
    const days = daysIn(from, to);
    const byWeekday = WEEKDAYS.map((weekday) => ({ weekday, checkIns: 0 }));
    for (const [d, v] of perDay) {
      const idx = (parseDateOnly(d)!.getUTCDay() + 6) % 7;
      byWeekday[idx]!.checkIns += v.checkIns;
    }
    return {
      from,
      to,
      groupBy,
      series,
      totals: {
        checkIns: total,
        uniqueMembers: unique.length,
        averagePerDay: Math.round((total / days.length) * 10) / 10,
      },
      byHour: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        checkIns: byHourRows.find((h) => h._id === hour)?.n ?? 0,
      })),
      byWeekday,
    };
  }

  /** Joined and archived per period; total and active members at the end of each period. */
  async function growth(q: RangeQuery) {
    const { tz, today } = await gym();
    const { from, to, groupBy } = resolveRange(q, today);
    const [members, ms] = await Promise.all([
      Member.find()
        .select('joinDate archivedAt')
        .lean<{ joinDate: Date; archivedAt?: Date | null }[]>(),
      Membership.find({
        cancelledAt: null,
        endDate: { $gte: parseDateOnly(from)! },
        startDate: { $lte: parseDateOnly(to)! },
      })
        .select('memberId startDate endDate')
        .lean<MsRow[]>(),
    ]);
    const archivedDay = (d?: Date | null) => (d ? todayIn(tz, d) : null);
    const perDay = new Map<string, { joined: number; archived: number }>();
    const at = (d: string) =>
      perDay.get(d) ?? (perDay.set(d, { joined: 0, archived: 0 }), perDay.get(d)!);
    for (const m of members) {
      at(formatDateOnly(m.joinDate)!).joined += 1;
      const a = archivedDay(m.archivedAt);
      if (a) at(a).archived += 1;
    }
    const folded = fold(perDay, from, to, groupBy, () => ({ joined: 0, archived: 0 }));
    const series = folded.map(({ period, values }) => {
      const end = bucketEnd(period, groupBy, to);
      const endDate = parseDateOnly(end)!;
      const totalMembers = members.filter((m) => {
        const a = archivedDay(m.archivedAt);
        return formatDateOnly(m.joinDate)! <= end && (!a || a > end);
      }).length;
      const activeMembers = new Set(
        ms
          .filter((x) => x.startDate <= endDate && x.endDate >= endDate)
          .map((x) => String(x.memberId)),
      ).size;
      return { period, asOf: end, ...values, totalMembers, activeMembers };
    });
    return {
      from,
      to,
      groupBy,
      series,
      totals: {
        joined: series.reduce((a, r) => a + r.joined, 0),
        archived: series.reduce((a, r) => a + r.archived, 0),
        netChange: series.reduce((a, r) => a + r.joined - r.archived, 0),
      },
    };
  }

  /**
   * Memberships ending in the range: renewed on time (next starts the day after), renewed late,
   * not renewed (ended, nothing after), or pending (ends today or later, nothing after yet).
   */
  async function renewals(q: RangeQuery) {
    const { today } = await gym();
    const { from, to, groupBy } = resolveRange(q, today);
    const ending = await Membership.find({
      cancelledAt: null,
      endDate: { $gte: parseDateOnly(from)!, $lte: parseDateOnly(to)! },
    })
      .select('memberId startDate endDate')
      .lean<MsRow[]>();
    const all = ending.length
      ? await Membership.find({
          cancelledAt: null,
          memberId: { $in: [...new Set(ending.map((m) => m.memberId))] },
        })
          .select('memberId startDate endDate')
          .lean<MsRow[]>()
      : [];
    type Row = {
      ending: number;
      renewedOnTime: number;
      renewedLate: number;
      notRenewed: number;
      pending: number;
    };
    const zero = (): Row => ({
      ending: 0,
      renewedOnTime: 0,
      renewedLate: 0,
      notRenewed: 0,
      pending: 0,
    });
    const perDay = new Map<string, Row>();
    for (const m of ending) {
      const day = formatDateOnly(m.endDate)!;
      const row = perDay.get(day) ?? (perDay.set(day, zero()), perDay.get(day)!);
      row.ending += 1;
      const next = nextAfter(all, m);
      if (next) {
        if (daysBetween(m.endDate, next.startDate) <= 1) row.renewedOnTime += 1;
        else row.renewedLate += 1;
      } else if (day >= today) row.pending += 1;
      else row.notRenewed += 1;
    }
    const rate = (r: Row) => {
      const decided = r.renewedOnTime + r.renewedLate + r.notRenewed;
      return decided ? Math.round(((r.renewedOnTime + r.renewedLate) / decided) * 100) / 100 : null;
    };
    const series = fold(perDay, from, to, groupBy, zero).map(({ period, values }) => ({
      period,
      ...values,
      renewalRate: rate(values),
    }));
    const totals = series.reduce((a, r) => {
      for (const k of Object.keys(a) as (keyof Row)[]) a[k] += r[k];
      return a;
    }, zero());
    return { from, to, groupBy, series, totals: { ...totals, renewalRate: rate(totals) } };
  }

  return { dashboard, revenue, memberships, attendance, growth, renewals };
}

export type ReportService = ReturnType<typeof createReportService>;
