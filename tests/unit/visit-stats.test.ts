import { describe, expect, it } from 'vitest';
import { visitStats } from '../../src/modules/attendance/visit-stats.js';

// 20 Nov 2026 is a Friday; that week runs Mon 16 – Sun 22 Nov.
const TODAY = '2026-11-20';

describe('visitStats', () => {
  it('no visits: zeros, no badges', () => {
    const s = visitStats([], TODAY);
    expect(s).toMatchObject({
      lifetimeVisits: 0,
      thisMonth: 0,
      thisWeek: 0,
      checkedInToday: false,
      currentStreak: 0,
      bestStreak: 0,
    });
    expect(s.week).toEqual([false, false, false, false, false, false, false]);
    expect(s.badges.map((b) => b.earnedOn)).toEqual([null, null, null, null, null]);
  });

  it('the current streak ends today when checked in today', () => {
    const s = visitStats(['2026-11-18', '2026-11-19', '2026-11-20'], TODAY);
    expect(s).toMatchObject({ checkedInToday: true, currentStreak: 3, bestStreak: 3 });
  });

  it('not checked in yet today: the streak up to yesterday still counts', () => {
    const s = visitStats(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'], TODAY);
    expect(s).toMatchObject({ checkedInToday: false, currentStreak: 4, thisWeek: 4 });
    expect(s.week).toEqual([true, true, true, true, false, false, false]);
  });

  it('a missed day breaks the streak; the best streak is kept', () => {
    const s = visitStats(
      ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-18'],
      TODAY,
    );
    expect(s).toMatchObject({ currentStreak: 0, bestStreak: 4 });
    // Yesterday missing but the day before visited: still 0 (two days without a visit).
  });

  it('streaks run across month boundaries; the month count does not', () => {
    const s = visitStats(['2026-10-30', '2026-10-31', '2026-11-01'], '2026-11-01');
    expect(s).toMatchObject({ currentStreak: 3, bestStreak: 3, thisMonth: 1, lifetimeVisits: 3 });
  });

  it('the week is Monday to Sunday: last Sunday is not this week', () => {
    // 15 Nov 2026 is a Sunday (previous week), 16 Nov a Monday.
    const s = visitStats(['2026-11-15', '2026-11-16'], TODAY);
    expect(s.thisWeek).toBe(1);
    expect(s.week[0]).toBe(true);
    // A Sunday "today" is the last day of its own week.
    const sunday = visitStats(['2026-11-16', '2026-11-22'], '2026-11-22');
    expect(sunday.week).toEqual([true, false, false, false, false, false, true]);
  });

  it('badge dates are the days of the 1st, 10th, 25th… visit; duplicates and future days are ignored', () => {
    const days = Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
    const s = visitStats([...days, days[0]!, '2026-12-01'], TODAY);
    expect(s.lifetimeVisits).toBe(30);
    expect(s.badges).toEqual([
      { visits: 1, earnedOn: '2026-10-01' },
      { visits: 10, earnedOn: '2026-10-10' },
      { visits: 25, earnedOn: '2026-10-25' },
      { visits: 50, earnedOn: null },
      { visits: 100, earnedOn: null },
    ]);
  });
});
