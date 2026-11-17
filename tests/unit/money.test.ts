import { describe, expect, it } from 'vitest';
import { priceBreakdown } from '../../src/lib/money.js';

describe('priceBreakdown', () => {
  it('inclusive: ₹1,500 incl. 18% GST = ₹1,271.19 + ₹228.81', () => {
    expect(priceBreakdown(150000, 'inclusive', 18)).toEqual({
      basePaise: 127119,
      gstPaise: 22881,
      totalPaise: 150000,
    });
  });
  it('exclusive: ₹1,000 + 18% = ₹1,180', () => {
    expect(priceBreakdown(100000, 'exclusive', 18)).toEqual({
      basePaise: 100000,
      gstPaise: 18000,
      totalPaise: 118000,
    });
  });
  it('none / 0%: total is the price', () => {
    expect(priceBreakdown(99900, 'none', 18)).toEqual({
      basePaise: 99900,
      gstPaise: 0,
      totalPaise: 99900,
    });
    expect(priceBreakdown(99900, 'exclusive', 0).gstPaise).toBe(0);
  });
  it('discount comes off before tax', () => {
    expect(priceBreakdown(150000, 'exclusive', 18, 50000)).toEqual({
      basePaise: 100000,
      gstPaise: 18000,
      totalPaise: 118000,
    });
    expect(priceBreakdown(150000, 'inclusive', 18, 150000).totalPaise).toBe(0);
  });
  it('base + GST always equals total, to the paisa', () => {
    for (let p = 0; p < 20000; p += 37) {
      for (const mode of ['inclusive', 'exclusive'] as const) {
        for (const rate of [5, 12, 18, 28]) {
          const b = priceBreakdown(p, mode, rate);
          expect(b.basePaise + b.gstPaise).toBe(b.totalPaise);
          expect(Number.isInteger(b.gstPaise)).toBe(true);
        }
      }
    }
  });
  it('rejects non-integer paise and discounts larger than the price', () => {
    expect(() => priceBreakdown(99.5, 'none', 0)).toThrow();
    expect(() => priceBreakdown(100, 'none', 0, 101)).toThrow();
  });
});
