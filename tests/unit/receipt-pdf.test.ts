import { describe, expect, it } from 'vitest';
import {
  renderReceiptPdf,
  splitGst,
  type ReceiptData,
} from '../../src/modules/payments/receipt.pdf.js';

/** Text drawn in an uncompressed PDFKit file: hex strings inside TJ arrays. */
function textOf(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  return [...raw.matchAll(/<([0-9a-f]+)>/g)]
    .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
    .join('');
}

const base: ReceiptData = {
  gym: {
    name: 'Powerhouse Fitness',
    address: ['12 MG Road', 'Pune, Maharashtra, 411001'],
    phone: '+919800000001',
    email: 'owner@powerhouse.demo',
    gstin: '27AAPFU0939F1ZV',
  },
  receiptNumber: 'RCPT/2026-27/0042',
  receivedAtText: '17 Nov 2026, 6:45 pm',
  member: { name: 'Arjun Sharma', memberCode: 'M0001', phone: '+919811111111' },
  membership: {
    planName: 'Monthly',
    periodText: '17 Nov 2026 to 16 Dec 2026',
    pricePaise: 150000,
    discountPaise: 0,
    basePaise: 127119,
    gstPaise: 22881,
    gstRate: 18,
    totalPaise: 150000,
    paidPaise: 100000,
  },
  payment: { amountPaise: 50000, method: 'upi', reference: 'UPI998877', refundedPaise: 0 },
};

describe('receipt PDF', () => {
  it('prints gym, receipt number, member, GST split, payment and balance', async () => {
    const pdf = await renderReceiptPdf(base, { compress: false });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const t = textOf(pdf);
    for (const s of [
      'Powerhouse Fitness',
      'GSTIN: 27AAPFU0939F1ZV',
      'RCPT/2026-27/0042',
      'Arjun Sharma (M0001)',
      'Taxable value',
      'Rs. 1,271.19',
      'CGST @ 9%',
      'Rs. 114.40',
      'SGST @ 9%',
      'Rs. 114.41',
      'Membership total',
      'Rs. 1,500.00',
      'UPI',
      'UPI998877',
      'Amount received',
      'Rs. 500.00',
      'Balance due',
    ]) {
      expect(t, s).toContain(s);
    }
  });

  it('no GST lines for a gym without GST; shows discount and excess payments', async () => {
    const t = textOf(
      await renderReceiptPdf(
        {
          ...base,
          gym: { ...base.gym, gstin: null },
          membership: {
            ...base.membership,
            discountPaise: 20000,
            basePaise: 130000,
            gstPaise: 0,
            gstRate: 0,
            totalPaise: 130000,
            paidPaise: 140000,
          },
        },
        { compress: false },
      ),
    );
    expect(t).not.toContain('GSTIN');
    expect(t).not.toContain('CGST');
    expect(t).toContain('Discount');
    expect(t).toContain('Paid in excess');
  });

  it('splits GST into CGST + SGST to the paisa', () => {
    expect(splitGst(22881)).toEqual({ cgst: 11440, sgst: 11441 });
    expect(splitGst(18000)).toEqual({ cgst: 9000, sgst: 9000 });
    expect(splitGst(0)).toEqual({ cgst: 0, sgst: 0 });
  });
});
