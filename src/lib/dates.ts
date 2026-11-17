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
