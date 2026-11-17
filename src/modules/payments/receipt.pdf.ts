import PDFDocument from 'pdfkit';

/**
 * Renders a payment receipt as PDF. Pure: takes plain data, returns bytes; no database access.
 *
 * Standard PDF fonts have no ₹ glyph, so amounts print as "Rs. 1,500.00". GST is split into
 * CGST + SGST (gyms supply services within their own state); an odd paisa goes to SGST.
 * This is a payment receipt. Whether it also serves as a GST tax invoice is for the gym's CA to
 * confirm (see docs/SECURITY.md "Open findings").
 */
export interface ReceiptData {
  gym: {
    name: string;
    address: string[];
    phone?: string | null;
    email?: string | null;
    gstin?: string | null;
  };
  receiptNumber: string;
  /** Formatted in the gym's time zone, e.g. "17 Nov 2026, 6:45 pm". */
  receivedAtText: string;
  member: { name: string; memberCode: string; phone: string };
  membership: {
    planName: string;
    periodText: string;
    pricePaise: number;
    discountPaise: number;
    basePaise: number;
    gstPaise: number;
    gstRate: number;
    totalPaise: number;
    paidPaise: number;
  };
  payment: {
    amountPaise: number;
    method: string;
    reference?: string | null;
    refundedPaise: number;
  };
}

const rupees = (paise: number) =>
  'Rs. ' +
  (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const METHOD: Record<string, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  razorpay: 'Online (Razorpay)',
};

export function splitGst(gstPaise: number) {
  const cgst = Math.floor(gstPaise / 2);
  return { cgst, sgst: gstPaise - cgst };
}

export function renderReceiptPdf(
  d: ReceiptData,
  opts: { compress?: boolean } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A5',
      margin: 36,
      compress: opts.compress ?? true,
      info: { Title: `Receipt ${d.receiptNumber}`, Author: d.gym.name },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - 72;
    const row = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      doc.text(label, 36, y, { width: width * 0.6 });
      doc.text(value, 36 + width * 0.6, y, { width: width * 0.4, align: 'right' });
      doc.moveDown(0.25);
    };
    const rule = () => {
      doc.moveDown(0.3);
      doc
        .moveTo(36, doc.y)
        .lineTo(36 + width, doc.y)
        .lineWidth(0.5)
        .strokeColor('#999')
        .stroke();
      doc.moveDown(0.5);
    };

    // Gym
    doc.font('Helvetica-Bold').fontSize(14).text(d.gym.name, { align: 'center' });
    doc.font('Helvetica').fontSize(8);
    for (const line of d.gym.address) doc.text(line, { align: 'center' });
    const contact = [d.gym.phone, d.gym.email].filter(Boolean).join('  |  ');
    if (contact) doc.text(contact, { align: 'center' });
    if (d.gym.gstin) doc.text(`GSTIN: ${d.gym.gstin}`, { align: 'center' });
    rule();

    doc.font('Helvetica-Bold').fontSize(12).text('PAYMENT RECEIPT', { align: 'center' });
    doc.moveDown(0.5);
    row('Receipt no.', d.receiptNumber, true);
    row('Date', d.receivedAtText);
    row('Received from', `${d.member.name} (${d.member.memberCode})`);
    row('Phone', d.member.phone);
    rule();

    const m = d.membership;
    row('Plan', m.planName, true);
    row('Period', m.periodText);
    row('Plan price', rupees(m.pricePaise));
    if (m.discountPaise) row('Discount', '- ' + rupees(m.discountPaise));
    if (m.gstPaise > 0) {
      const { cgst, sgst } = splitGst(m.gstPaise);
      const half = m.gstRate / 2;
      row('Taxable value', rupees(m.basePaise));
      row(`CGST @ ${half}%`, rupees(cgst));
      row(`SGST @ ${half}%`, rupees(sgst));
    }
    row('Membership total', rupees(m.totalPaise), true);
    rule();

    const p = d.payment;
    row('Amount received', rupees(p.amountPaise), true);
    row('Mode', METHOD[p.method] ?? p.method);
    if (p.reference) row('Reference', p.reference);
    if (p.refundedPaise) row('Refunded from this payment', '- ' + rupees(p.refundedPaise));
    row('Paid to date', rupees(m.paidPaise));
    const balance = m.totalPaise - m.paidPaise;
    row(balance >= 0 ? 'Balance due' : 'Paid in excess', rupees(Math.abs(balance)), true);
    rule();

    doc.font('Helvetica').fontSize(7).fillColor('#555');
    doc.text('This is a computer-generated receipt and does not need a signature.', {
      align: 'center',
    });
    doc.end();
  });
}
