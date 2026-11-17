/**
 * Calendar dates (join date, date of birth) are stored as UTC midnight of that date and exchanged
 * as `YYYY-MM-DD`, so a date never shifts by a day between time zones.
 */
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateOnly(s: string): Date | null {
  if (!DATE_ONLY.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}

export function formatDateOnly(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Today's date in the gym's time zone (e.g. 00:30 IST is still "yesterday" in UTC). */
export function todayIn(timeZone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const DAY_MS = 86_400_000;

/** Calendar arithmetic on UTC-midnight dates. */
export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** Whole days from a to b (b - a), for UTC-midnight dates. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/**
 * Last day (inclusive) of a period of `months` calendar months starting on `start`: the day before
 * the same date `months` later (15 Jan + 1 → 14 Feb). If that date doesn't exist, the period runs
 * to the end of that month (31 Jan + 1 → 28/29 Feb), so a member never loses the short month.
 * Renewals chain without gaps: the next period starts the day after.
 */
export function periodEnd(start: Date, months: number): Date {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth() + months;
  const d = start.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  if (d > lastDayOfTarget) return new Date(Date.UTC(y, m, lastDayOfTarget));
  return new Date(Date.UTC(y, m, d - 1));
}

/**
 * Indian financial year (April–March) of a calendar date string `YYYY-MM-DD`, e.g. 2026-04-01 and
 * 2027-03-31 are both "2026-27".
 */
export function financialYear(dateOnly: string): string {
  const [y, m] = dateOnly.split('-').map(Number) as [number, number];
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Minutes the zone is ahead of UTC at `at` (IST = +330). */
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The instant a calendar day starts in a time zone: 2026-04-01 in Asia/Kolkata → 2026-03-31T18:30Z. */
export function startOfDayIn(dateOnly: string, timeZone: string): Date {
  const guess = parseDateOnly(dateOnly)!;
  let t = guess.getTime() - zoneOffsetMinutes(timeZone, guess) * 60_000;
  // Second pass settles DST transitions (India has none; other zones might).
  t = guess.getTime() - zoneOffsetMinutes(timeZone, new Date(t)) * 60_000;
  return new Date(t);
}
