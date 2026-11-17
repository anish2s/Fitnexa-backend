import { Types } from 'mongoose';
import { formatDateOnly, parseDateOnly, todayIn } from '../../lib/dates.js';
import { AppError, Errors } from '../../lib/errors.js';
import { pageMeta, skipFor } from '../../lib/pagination.js';
import { requireTenantId } from '../../tenancy/context.js';
import type { AuditContext } from '../audit/audit.service.js';
import { Member } from '../members/member.model.js';
import { Membership } from '../memberships/membership.model.js';
import {
  membershipSummary,
  toMembershipView,
  type LeanMembership,
} from '../memberships/membership.service.js';
import { isDuplicateKey } from '../payments/payment.ledger.js';
import { Tenant } from '../tenants/tenant.model.js';
import { User } from '../users/user.model.js';
import { Attendance, type LeanAttendance } from './attendance.model.js';
import type { DayQuery, RangeQuery } from './attendance.schemas.js';
import type { PassSigner } from './qr-pass.js';

type LeanMember = {
  _id: Types.ObjectId;
  name: string;
  memberCode: string;
  phone: string;
  photoUrl?: string | null;
  archivedAt?: Date | null;
};

const memberCard = (m: LeanMember) => ({
  id: String(m._id),
  name: m.name,
  memberCode: m.memberCode,
  phone: m.phone ?? null,
  /** Shown at the desk so staff can see the pass belongs to the person in front of them. */
  photoUrl: m.photoUrl ?? null,
});

const checkInView = (a: LeanAttendance) => ({
  id: String(a._id),
  memberId: String(a.memberId),
  membershipId: String(a.membershipId),
  day: a.day,
  checkedInAt: a.checkedInAt,
  method: a.method,
});

/** Gym-local today and hour for an instant, from the gym's time zone. */
async function gymClock(at = new Date()) {
  const t = await Tenant.findById(requireTenantId()).select('settings.timezone').lean();
  const tz = t?.settings?.timezone ?? 'Asia/Kolkata';
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(
      at,
    ),
  );
  return { day: todayIn(tz, at), hour, tz };
}

export function createAttendanceService(deps: { passes: PassSigner }) {
  const { passes } = deps;

  /**
   * The membership that lets this member in today, or a 409 that tells the desk why not
   * (expired on…, starts on…, none).
   */
  async function admittingMembership(memberId: Types.ObjectId, today: Date) {
    const active = await Membership.findOne({
      memberId,
      cancelledAt: null,
      startDate: { $lte: today },
      endDate: { $gte: today },
    }).lean<LeanMembership>();
    if (active) return active;
    const next = await Membership.findOne({
      memberId,
      cancelledAt: null,
      startDate: { $gt: today },
    })
      .sort({ startDate: 1 })
      .lean<LeanMembership>();
    if (next) {
      throw new AppError(
        409,
        'NO_ACTIVE_MEMBERSHIP',
        `Membership starts on ${formatDateOnly(next.startDate)}`,
        {
          reason: 'upcoming',
          date: formatDateOnly(next.startDate),
        },
      );
    }
    const last = await Membership.findOne({ memberId, cancelledAt: null })
      .sort({ endDate: -1 })
      .lean<LeanMembership>();
    throw new AppError(
      409,
      'NO_ACTIVE_MEMBERSHIP',
      last
        ? `Membership expired on ${formatDateOnly(last.endDate)}`
        : 'No membership. Sell a plan first.',
      { reason: last ? 'expired' : 'none', date: last ? formatDateOnly(last.endDate) : null },
    );
  }

  async function checkIn(memberId: string, method: 'qr' | 'manual', ctx: AuditContext) {
    const member = await Member.findById(memberId)
      .select('name memberCode phone photoUrl archivedAt')
      .lean<LeanMember>();
    if (!member) throw Errors.notFound('Member');
    if (member.archivedAt) throw Errors.conflict('Member is archived');

    const now = new Date();
    const { day, hour } = await gymClock(now);
    const today = parseDateOnly(day)!;
    const membership = await admittingMembership(member._id, today);

    let record = await Attendance.findOne({ memberId: member._id, day }).lean<LeanAttendance>();
    let status: 'checked_in' | 'already_checked_in' = 'already_checked_in';
    if (!record) {
      try {
        const doc = await Attendance.create({
          memberId: member._id,
          membershipId: membership._id,
          day,
          hour,
          checkedInAt: now,
          method,
          recordedBy: ctx.actor.id ? new Types.ObjectId(ctx.actor.id) : undefined,
        });
        record = doc.toObject() as unknown as LeanAttendance;
        status = 'checked_in';
      } catch (err) {
        // Two scans at the same moment: the other one won.
        if (!isDuplicateKey(err, 'day')) throw err;
        record = await Attendance.findOne({ memberId: member._id, day }).lean<LeanAttendance>();
      }
    }
    const ms = toMembershipView(membership, today);
    return {
      status,
      checkIn: checkInView(record!),
      member: memberCard(member),
      membership: {
        id: ms.id,
        plan: ms.plan.name,
        endDate: ms.endDate,
        daysLeft: ms.daysLeft,
        balancePaise: ms.balancePaise,
        paymentStatus: ms.paymentStatus,
      },
    };
  }

  async function scan(token: string, ctx: AuditContext) {
    const result = passes.verify(requireTenantId().toHexString(), token);
    if (!result.ok) throw result.reason === 'expired' ? Errors.passExpired() : Errors.passInvalid();
    return checkIn(result.memberId, 'qr', ctx);
  }

  async function memberIdOfUser(userId: string) {
    const u = await User.findOne({ _id: userId, role: 'member' }).select('memberId').lean();
    if (!u?.memberId) throw Errors.notFound('Member profile');
    return u.memberId;
  }

  /** The member app's QR. Refresh at `refreshAt`; shows membership status alongside. */
  async function issuePass(userId: string) {
    const memberId = await memberIdOfUser(userId);
    const m = await Member.findOne({ _id: memberId, archivedAt: null })
      .select('name memberCode photoUrl')
      .lean<LeanMember>();
    if (!m) throw Errors.notFound('Member profile');
    const { day } = await gymClock();
    const pass = passes.issue(requireTenantId().toHexString(), String(memberId));
    const summary = await membershipSummary(memberId, parseDateOnly(day)!);
    const checkedInToday = await Attendance.findOne({ memberId, day }).select('checkedInAt').lean();
    return {
      ...pass,
      member: { name: m.name, memberCode: m.memberCode, photoUrl: m.photoUrl ?? null },
      membershipStatus: summary.status,
      checkedInToday: checkedInToday ? checkedInToday.checkedInAt : null,
    };
  }

  async function withMembers(rows: LeanAttendance[]) {
    const members = await Member.find({ _id: { $in: rows.map((r) => r.memberId) } })
      .select('name memberCode phone photoUrl')
      .lean<LeanMember[]>();
    const byId = new Map(members.map((m) => [String(m._id), m]));
    return rows.map((r) => {
      const m = byId.get(String(r.memberId));
      return { ...checkInView(r), member: m ? memberCard(m) : null };
    });
  }

  async function forDay(q: DayQuery) {
    const day = q.date ?? (await gymClock()).day;
    const filter = { day };
    const [rows, total] = await Promise.all([
      Attendance.find(filter)
        .sort({ checkedInAt: -1, _id: -1 })
        .skip(skipFor(q))
        .limit(q.limit)
        .lean<LeanAttendance[]>(),
      Attendance.countDocuments(filter),
    ]);
    return { items: await withMembers(rows), meta: { ...pageMeta(q, total), date: day } };
  }

  async function history(memberId: Types.ObjectId | string, q: RangeQuery) {
    const filter: Record<string, unknown> = { memberId: new Types.ObjectId(String(memberId)) };
    if (q.from || q.to)
      filter.day = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    const [rows, total] = await Promise.all([
      Attendance.find(filter)
        .sort({ day: -1 })
        .skip(skipFor(q))
        .limit(q.limit)
        .lean<LeanAttendance[]>(),
      Attendance.countDocuments(filter),
    ]);
    return { items: rows.map(checkInView), meta: pageMeta(q, total) };
  }

  async function memberHistory(memberId: string, q: RangeQuery) {
    if (!(await Member.exists({ _id: memberId }))) throw Errors.notFound('Member');
    return history(memberId, q);
  }

  async function selfHistory(userId: string, q: RangeQuery) {
    return history(await memberIdOfUser(userId), q);
  }

  /** One day: totals, QR vs manual, visits per gym-local hour, and share of active members. */
  async function report(date?: string) {
    const day = date ?? (await gymClock()).day;
    const onDay = parseDateOnly(day)!;
    const [byMethod, byHour, activeMemberIds] = await Promise.all([
      Attendance.aggregate<{ _id: string; n: number }>([
        { $match: { day } },
        { $group: { _id: '$method', n: { $sum: 1 } } },
      ]),
      Attendance.aggregate<{ _id: number; n: number }>([
        { $match: { day } },
        { $group: { _id: '$hour', n: { $sum: 1 } } },
      ]),
      Membership.distinct('memberId', {
        cancelledAt: null,
        startDate: { $lte: onDay },
        endDate: { $gte: onDay },
      }),
    ]);
    const methods = { qr: 0, manual: 0 } as Record<string, number>;
    for (const m of byMethod) methods[m._id] = m.n;
    const total = methods.qr! + methods.manual!;
    const hours = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      count: byHour.find((x) => x._id === h)?.n ?? 0,
    }));
    const active = activeMemberIds.length;
    const busiest = hours.reduce((a, b) => (b.count > a.count ? b : a), hours[0]!);
    return {
      date: day,
      total,
      byMethod: methods,
      byHour: hours,
      busiestHour: total ? busiest.hour : null,
      activeMembers: active,
      /** Check-ins ÷ members with an active membership that day, 0–1, two decimals. */
      attendanceRate: active ? Math.round((total / active) * 100) / 100 : null,
    };
  }

  return { checkIn, scan, issuePass, forDay, memberHistory, selfHistory, report };
}

export type AttendanceService = ReturnType<typeof createAttendanceService>;
