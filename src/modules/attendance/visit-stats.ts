import { addDays, formatDateOnly, parseDateOnly } from '../../lib/dates.js';

/** Visit milestones the member app shows as badges. */
export const BADGE_VISITS = [1, 10, 25, 50, 100] as const;

export interface VisitStats {
  today: string;
  lifetimeVisits: number;
  thisMonth: number;
  thisWeek: number;
  /** Monday … Sunday of the current week: was there a visit that day. */
  week: boolean[];
  checkedInToday: boolean;
  currentStreak: number;
  bestStreak: number;
  badges: { visits: (typeof BADGE_VISITS)[number]; earnedOn: string | null }[];
}

/**
 * Motivation figures from a member's visit days (gym-local `YYYY-MM-DD`, one per day: the
 * attendance index allows one check-in per member per day). Pure; `days` in any order.
 *
 * - Streak: consecutive days with a visit. The current streak ends today if there was a visit
 *   today, else yesterday (today isn't over yet), else it is 0.
 * - Week: Monday to Sunday containing `today`. Month: the calendar month of `today`.
 * - A badge's `earnedOn` is the day of the Nth visit.
 */
export function visitStats(rawDays: readonly string[], today: string): VisitStats {
  const days = [...new Set(rawDays)].filter((d) => d <= today).sort();
  const set = new Set(days);
  const todayDate = parseDateOnly(today)!;
  const iso = (d: Date) => formatDateOnly(d)!;

  // Monday of this week (getUTCDay: 0 = Sunday).
  const monday = addDays(todayDate, -((todayDate.getUTCDay() + 6) % 7));
  const week = Array.from({ length: 7 }, (_, i) => set.has(iso(addDays(monday, i))));

  let bestStreak = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const d of days) {
    const date = parseDateOnly(d)!;
    run = prev && iso(addDays(prev, 1)) === d ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    prev = date;
  }

  let currentStreak = 0;
  let cursor = set.has(today) ? todayDate : addDays(todayDate, -1);
  while (set.has(iso(cursor))) {
    currentStreak += 1;
    cursor = addDays(cursor, -1);
  }

  return {
    today,
    lifetimeVisits: days.length,
    thisMonth: days.filter((d) => d.slice(0, 7) === today.slice(0, 7)).length,
    thisWeek: week.filter(Boolean).length,
    week,
    checkedInToday: set.has(today),
    currentStreak,
    bestStreak,
    badges: BADGE_VISITS.map((visits) => ({ visits, earnedOn: days[visits - 1] ?? null })),
  };
}
