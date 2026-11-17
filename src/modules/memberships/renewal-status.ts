import type { Types } from 'mongoose';
import { parseDateOnly } from '../../lib/dates.js';
import { Member } from '../members/member.model.js';
import { Membership } from './membership.model.js';

export type MsRow = {
  _id: Types.ObjectId;
  memberId: Types.ObjectId;
  startDate: Date;
  endDate: Date;
};

/** The member's next non-cancelled membership after `m`, if any. */
export function nextAfter(all: MsRow[], m: MsRow) {
  return all
    .filter((x) => String(x.memberId) === String(m.memberId) && x.startDate > m.endDate)
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())[0];
}

/**
 * Non-cancelled memberships ending in [from, to] (gym-local dates) whose member hasn't renewed
 * (no later non-cancelled membership) and isn't archived. Shared by the dashboard, the renewals
 * report and renewal reminders, so they always agree.
 */
export async function unrenewedEnding(from: string, to: string): Promise<MsRow[]> {
  const ending = await Membership.find({
    cancelledAt: null,
    endDate: { $gte: parseDateOnly(from)!, $lte: parseDateOnly(to)! },
  })
    .select('memberId startDate endDate')
    .lean<MsRow[]>();
  if (!ending.length) return [];
  const memberIds = [...new Set(ending.map((m) => String(m.memberId)))];
  const [all, live] = await Promise.all([
    Membership.find({ cancelledAt: null, memberId: { $in: memberIds } })
      .select('memberId startDate endDate')
      .lean<MsRow[]>(),
    Member.distinct('_id', { _id: { $in: memberIds }, archivedAt: null }),
  ]);
  const liveSet = new Set(live.map(String));
  return ending.filter((m) => liveSet.has(String(m.memberId)) && !nextAfter(all, m));
}
