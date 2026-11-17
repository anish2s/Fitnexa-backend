import { describe, expect, it } from 'vitest';
import {
  bucketEnd,
  bucketOf,
  bucketsIn,
  daysIn,
  defaultGroupBy,
  fold,
} from '../../src/modules/reports/periods.js';

describe('report periods', () => {
  it('buckets days into Monday weeks and calendar months', () => {
    expect(bucketOf('2026-11-17', 'day')).toBe('2026-11-17');
    expect(bucketOf('2026-11-17', 'week')).toBe('2026-11-16'); // Tuesday → Monday
    expect(bucketOf('2026-11-16', 'week')).toBe('2026-11-16'); // Monday
    expect(bucketOf('2026-11-22', 'week')).toBe('2026-11-16'); // Sunday
    expect(bucketOf('2026-01-01', 'week')).toBe('2025-12-29'); // across a year
    expect(bucketOf('2026-11-30', 'month')).toBe('2026-11-01');
  });
  it('lists every bucket in a range, empty ones included', () => {
    expect(daysIn('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    expect(bucketsIn('2026-01-15', '2026-04-02', 'month')).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
    ]);
    expect(bucketsIn('2026-11-01', '2026-11-17', 'week')).toEqual([
      '2026-10-26',
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
    ]);
  });
  it('bucket ends are clipped to the range', () => {
    expect(bucketEnd('2026-02-01', 'month', '2026-12-31')).toBe('2026-02-28');
    expect(bucketEnd('2026-11-16', 'week', '2026-11-18')).toBe('2026-11-18');
    expect(bucketEnd('2026-11-17', 'day', '2026-11-30')).toBe('2026-11-17');
  });
  it('picks a grouping that suits the range', () => {
    expect(defaultGroupBy('2026-11-01', '2026-11-30')).toBe('day');
    expect(defaultGroupBy('2026-09-01', '2026-11-30')).toBe('week');
    expect(defaultGroupBy('2026-01-01', '2026-12-31')).toBe('month');
  });
  it('folds per-day totals; day, week and month always add up to the same total', () => {
    const perDay = new Map([
      ['2026-11-02', { n: 2 }],
      ['2026-11-09', { n: 3 }],
      ['2026-11-30', { n: 5 }],
      ['2026-12-05', { n: 99 }], // outside the range: ignored
    ]);
    const sum = (rows: { values: { n: number } }[]) => rows.reduce((a, r) => a + r.values.n, 0);
    for (const by of ['day', 'week', 'month'] as const) {
      expect(sum(fold(perDay, '2026-11-01', '2026-11-30', by, () => ({ n: 0 })))).toBe(10);
    }
    const weeks = fold(perDay, '2026-11-01', '2026-11-30', 'week', () => ({ n: 0 }));
    expect(weeks.map((w) => w.values.n)).toEqual([0, 2, 3, 0, 0, 5]);
  });
});
