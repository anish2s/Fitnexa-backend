import { describe, expect, it } from 'vitest';
import { messageFor, rupees, waLink } from '../../src/modules/whatsapp/whatsapp.js';

describe('WhatsApp links', () => {
  it('uses digits only and encodes the text safely', () => {
    const url = waLink('+919811111111', 'Hi Arjun,\nPay ₹1,000 & renew? नमस्ते');
    expect(url.startsWith('https://wa.me/919811111111?text=')).toBe(true);
    const text = decodeURIComponent(new URL(url).searchParams.get('text')!);
    expect(text).toBe('Hi Arjun,\nPay ₹1,000 & renew? नमस्ते');
    expect(url).not.toMatch(/\s/); // spaces and newlines are encoded
    expect(new URL(url).search.split('&')).toHaveLength(1); // the & in the text is encoded too
  });
  it('formats rupees the Indian way, without .00 for whole amounts', () => {
    expect(rupees(150000)).toBe('₹1,500');
    expect(rupees(127119)).toBe('₹1,271.19');
    expect(rupees(1_00_00_000)).toBe('₹1,00,000');
  });
  it('fills templates; returns null when a template does not apply', () => {
    const c = {
      gymName: 'Powerhouse Fitness',
      appUrl: 'https://powerhouse.yourapp.in',
      memberName: 'Arjun Sharma',
      memberCode: 'M0001',
      membership: { plan: 'Monthly', endDate: '2026-11-21', ended: false, balancePaise: 100000 },
    };
    expect(messageFor('renewal', c)).toBe(
      "Hi Arjun, your Monthly membership at Powerhouse Fitness ends on 21 Nov 2026. Renew at the front desk so your workouts don't stop. Your pass and plan: https://powerhouse.yourapp.in",
    );
    expect(messageFor('renewal', { ...c, membership: { ...c.membership, ended: true } })).toContain(
      'ended on 21 Nov 2026',
    );
    expect(messageFor('payment_due', c)).toContain('a balance of ₹1,000 is due');
    expect(
      messageFor('payment_due', { ...c, membership: { ...c.membership, balancePaise: 0 } }),
    ).toBeNull();
    expect(messageFor('renewal', { ...c, membership: null })).toBeNull();
    expect(messageFor('welcome', c)).toContain('Your member code is M0001');
  });
});
