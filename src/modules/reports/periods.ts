import { addDays, daysBetween, formatDateOnly, parseDateOnly } from '../../lib/dates.js';

/**
 * Report periods over gym-local calendar dates (YYYY-MM-DD). Everything is bucketed from per-day
 * totals in JS, so day, week and month reports agree with each other by construction.
 */
export type GroupBy = 'day' | 'week' | 'month';
export const MAX_RANGE_DAYS = 366;

/** Monday-start weeks (Indian business convention); months by calendar. */
export function bucketOf(day: string, by: GroupBy): string {
  if (by === 'day') return day;
  if (by === 'month') return `${day.slice(0, 7)}-01`;
  const d = parseDateOnly(day)!;
  const mondayOffset = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return formatDateOnly(addDays(d, -mondayOffset))!;
}

/** Every day in [from, to], inclusive. */
export function daysIn(from: string, to: string): string[] {
  const start = parseDateOnly(from)!;
  const n = daysBetween(start, parseDateOnly(to)!);
  return Array.from({ length: n + 1 }, (_, i) => formatDateOnly(addDays(start, i))!);
}

/** Bucket keys covering [from, to], in order, so empty periods show as zero. */
export function bucketsIn(from: string, to: string, by: GroupBy): string[] {
  return [...new Set(daysIn(from, to).map((d) => bucketOf(d, by)))];
}

/** Last day of the bucket, clipped to `to` (for "as of the end of the period" figures). */
export function bucketEnd(bucket: string, by: GroupBy, to: string): string {
  let end: string;
  if (by === 'day') end = bucket;
  else if (by === 'week') end = formatDateOnly(addDays(parseDateOnly(bucket)!, 6))!;
  else {
    const d = parseDateOnly(bucket)!;
    end = formatDateOnly(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)))!;
  }
  return end < to ? end : to;
}

/** Sensible default grouping for a range length. */
export function defaultGroupBy(from: string, to: string): GroupBy {
  const days = daysBetween(parseDateOnly(from)!, parseDateOnly(to)!) + 1;
  return days <= 31 ? 'day' : days <= 92 ? 'week' : 'month';
}

/** Sums per-day values into buckets. */
export function fold<T extends Record<string, number>>(
  perDay: Map<string, T>,
  from: string,
  to: string,
  by: GroupBy,
  zero: () => T,
): { period: string; values: T }[] {
  const out = new Map(bucketsIn(from, to, by).map((b) => [b, zero()]));
  for (const [day, v] of perDay) {
    if (day < from || day > to) continue;
    const acc = out.get(bucketOf(day, by))!;
    for (const k of Object.keys(v) as (keyof T)[]) (acc[k] as number) += v[k] as number;
  }
  return [...out].map(([period, values]) => ({ period, values }));
}
