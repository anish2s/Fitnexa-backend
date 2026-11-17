import { describe, expect, it } from 'vitest';
import {
  financialYear,
  formatDateOnly,
  parseDateOnly,
  periodEnd,
  startOfDayIn,
  todayIn,
} from '../../src/lib/dates.js';

const end = (start: string, months: number) =>
  formatDateOnly(periodEnd(parseDateOnly(start)!, months));

describe('periodEnd', () => {
  it('ends the day before the same date N months later', () => {
    expect(end('2026-01-15', 1)).toBe('2026-02-14');
    expect(end('2026-01-01', 1)).toBe('2026-01-31');
    expect(end('2026-04-10', 3)).toBe('2026-07-09');
    expect(end('2026-04-10', 6)).toBe('2026-10-09');
    expect(end('2026-04-10', 12)).toBe('2027-04-09');
    expect(end('2026-11-17', 3)).toBe('2027-02-16');
  });
  it('runs to the end of the month when that date does not exist', () => {
    expect(end('2026-01-31', 1)).toBe('2026-02-28');
    expect(end('2028-01-31', 1)).toBe('2028-02-29');
    expect(end('2026-01-29', 1)).toBe('2026-02-28');
    expect(end('2026-11-30', 3)).toBe('2027-02-28');
    expect(end('2026-08-31', 6)).toBe('2027-02-28');
    expect(end('2028-02-29', 12)).toBe('2029-02-28');
    expect(end('2026-03-31', 1)).toBe('2026-04-30');
  });
  it('renewals chain with no gap and no overlap', () => {
    let start = parseDateOnly('2026-01-31')!;
    const seen: string[] = [];
    for (let i = 0; i < 14; i++) {
      const e = periodEnd(start, 1);
      expect(e.getTime()).toBeGreaterThanOrEqual(start.getTime());
      seen.push(`${formatDateOnly(start)}..${formatDateOnly(e)}`);
      start = new Date(e.getTime() + 86_400_000);
    }
    expect(seen.slice(0, 3)).toEqual([
      '2026-01-31..2026-02-28',
      '2026-03-01..2026-03-31',
      '2026-04-01..2026-04-30',
    ]);
  });
});

describe('todayIn', () => {
  it("uses the gym's time zone, not UTC", () => {
    // 20:00 UTC on 31 Mar is already 1 Apr in India.
    expect(todayIn('Asia/Kolkata', new Date('2026-03-31T20:00:00Z'))).toBe('2026-04-01');
    expect(todayIn('UTC', new Date('2026-03-31T20:00:00Z'))).toBe('2026-03-31');
  });
});

describe('financialYear', () => {
  it('runs April to March', () => {
    expect(financialYear('2026-04-01')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(financialYear('2026-03-31')).toBe('2025-26');
    expect(financialYear('2099-12-01')).toBe('2099-00');
  });
});

describe('startOfDayIn', () => {
  it('is local midnight as a UTC instant', () => {
    expect(startOfDayIn('2026-04-01', 'Asia/Kolkata').toISOString()).toBe(
      '2026-03-31T18:30:00.000Z',
    );
    expect(startOfDayIn('2026-04-01', 'UTC').toISOString()).toBe('2026-04-01T00:00:00.000Z');
    // DST zone: New York is UTC-4 in July.
    expect(startOfDayIn('2026-07-01', 'America/New_York').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
  });
});
