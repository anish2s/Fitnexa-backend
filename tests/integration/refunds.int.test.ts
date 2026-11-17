import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog, Member, Membership, Payment, User } from '../../src/db/models.js';
import { financialYear, todayIn } from '../../src/lib/dates.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

const { mailer, call, tokenFor, memberToken } = intApp();
const key = () => randomUUID();
const FY = () => financialYear(todayIn('Asia/Kolkata'));

/** The seeded payment of a Powerhouse member (Vikram: Annual ₹12,000 paid in full in cash). */
async function paymentOf(phone: string, slug = 'powerhouse') {
  return runInTenant(await gymId(slug), async () => {
    const m = await Member.findOne({ phone }).lean();
    const p = await Payment.findOne({ memberId: m!._id }).lean();
    return { id: String(p!._id), membershipId: String(p!.membershipId), amount: p!.amountPaise };
  });
}
const VIKRAM = '+919811111113';
const ARJUN = '+919811111111';

describeWithDb('refunds (real MongoDB)', () => {
  let owner: string;
  let desk: string;

  beforeAll(async () => {
    await connectTestDb(`refunds_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
  });

  const refund = (id: string, body: object, k: string | null = key(), token = owner, host = PH) => {
    const r = call('post', host, `/payments/${id}/refunds`, token);
    return (k ? r.set('Idempotency-Key', k) : r).send(body);
  };

  it('owner refunds part of a payment: numbered, balances move, audited', async () => {
    const v = await paymentOf(VIKRAM);
    const res = await refund(v.id, {
      amountPaise: 200000,
      reason: 'Relocating, pro-rata',
      method: 'upi',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      refundedPaise: 200000,
      membership: { paidPaise: v.amount - 200000, balancePaise: 200000, paymentStatus: 'partial' },
    });
    expect(res.body.data.refunds[0]).toMatchObject({
      refundNumber: `RFND/${FY()}/0001`,
      amountPaise: 200000,
      method: 'upi',
      status: 'processed',
      reason: 'Relocating, pro-rata',
    });

    const rest = await refund(v.id, { amountPaise: v.amount - 200000, reason: 'Remainder' });
    expect(rest.body.data.refunds[1].refundNumber).toBe(`RFND/${FY()}/0002`);
    expect(rest.body.data.membership).toMatchObject({ paidPaise: 0, paymentStatus: 'unpaid' });
    expect((await refund(v.id, { amountPaise: 1, reason: 'too much' })).status).toBe(422);

    const log = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.find({ action: 'payment.refund' }).lean(),
    );
    expect(log).toHaveLength(2);
    expect(log.find((e) => e.metadata?.amountPaise === 200000)!.metadata).toMatchObject({
      reason: 'Relocating, pro-rata',
      method: 'upi',
    });

    // Totals in the payment list net out refunds.
    const list = await call('get', PH, '/payments', owner);
    expect(list.body.meta.totals.refundedPaise).toBe(v.amount);
  });

  it('idempotent: retry replays, key reuse is refused, parallel retries make one refund', async () => {
    const v = await paymentOf(VIKRAM);
    const k = key();
    const first = await refund(v.id, { amountPaise: 1000, reason: 'Overcharge' }, k);
    const again = await refund(v.id, { amountPaise: 1000, reason: 'Overcharge' }, k);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect((await refund(v.id, { amountPaise: 2000, reason: 'Overcharge' }, k)).status).toBe(409);
    const a = await paymentOf(ARJUN);
    expect((await refund(a.id, { amountPaise: 1000, reason: 'Overcharge' }, k)).status).toBe(409);

    const k2 = key();
    const burst = await Promise.all(
      Array.from({ length: 5 }, () => refund(v.id, { amountPaise: 500, reason: 'dup' }, k2)),
    );
    expect(burst.every((r) => [200, 201].includes(r.status))).toBe(true);
    const p = await runInTenant(await gymId('powerhouse'), () => Payment.findById(v.id).lean());
    expect(p!.refunds).toHaveLength(2);
    expect(p!.refundedPaise).toBe(1500);
  });

  it('parallel refunds with different keys never exceed the payment', async () => {
    const a = await paymentOf(ARJUN); // ₹500 cash
    const results = await Promise.all(
      Array.from({ length: 5 }, () => refund(a.id, { amountPaise: 20000, reason: 'race' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const p = await runInTenant(await gymId('powerhouse'), () => Payment.findById(a.id).lean());
    expect(p!.refundedPaise).toBe(40000);
    const m = await runInTenant(await gymId('powerhouse'), () =>
      Membership.findById(a.membershipId).lean(),
    );
    expect(m!.paidPaise).toBe(10000);
    // Refund numbers stay gap-free despite the refused attempts.
    expect(p!.refunds.map((r) => r.refundNumber).sort()).toEqual([
      `RFND/${FY()}/0001`,
      `RFND/${FY()}/0002`,
    ]);
  });

  it('422 for bad input or a missing key', async () => {
    const v = await paymentOf(VIKRAM);
    for (const body of [
      { amountPaise: 0, reason: 'x y z' },
      { amountPaise: 100, reason: '' },
      { amountPaise: 100.5, reason: 'abc' },
      { amountPaise: 100, reason: 'abc', method: 'card' },
    ]) {
      expect((await refund(v.id, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await refund(v.id, { amountPaise: 100, reason: 'abc' }, null)).status).toBe(422);
  });

  it('refunds need payments:refund: staff only when granted; members never', async () => {
    const v = await paymentOf(VIKRAM);
    expect((await refund(v.id, { amountPaise: 100, reason: 'desk' }, key(), desk)).status).toBe(
      403,
    );
    const deskId = await runInTenant(await gymId('powerhouse'), async () =>
      String((await User.findOne({ email: 'desk@powerhouse.demo' }).lean())!._id),
    );
    await call('patch', PH, `/staff/${deskId}`, owner).send({ permissions: ['payments:refund'] });
    expect((await refund(v.id, { amountPaise: 100, reason: 'desk' }, key(), desk)).status).toBe(
      201,
    );
    const member = await memberToken(PH, 'vikram@member.demo');
    expect((await refund(v.id, { amountPaise: 100, reason: 'me' }, key(), member)).status).toBe(
      403,
    );
    expect(
      (
        await call('post', PH, `/payments/${v.id}/refunds`)
          .set('Idempotency-Key', key())
          .send({ amountPaise: 1, reason: 'abc' })
      ).status,
    ).toBe(401);
  });

  it('the member sees refunds on their payments, without the internal reason', async () => {
    const v = await paymentOf(VIKRAM);
    await refund(v.id, { amountPaise: 100000, reason: 'Owner goodwill, staff error' });
    const me = await memberToken(PH, 'vikram@member.demo');
    const res = await call('get', PH, '/members/me/payments', me);
    expect(res.body.data[0].refunds[0]).toMatchObject({ amountPaise: 100000, status: 'processed' });
    expect(JSON.stringify(res.body)).not.toContain('goodwill');
  });

  it("cross-tenant: FitZone can't refund a Powerhouse payment; numbering is per gym", async () => {
    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    const v = await paymentOf(VIKRAM);
    expect(
      (await refund(v.id, { amountPaise: 100, reason: 'evil' }, key(), fzOwner, FZ)).status,
    ).toBe(404);
    const fzPay = await paymentOf(ARJUN, 'fitzone');
    const fzRefund = await refund(
      fzPay.id,
      { amountPaise: 100, reason: 'goodwill' },
      key(),
      fzOwner,
      FZ,
    );
    expect(fzRefund.status, JSON.stringify(fzRefund.body)).toBe(201);
    expect(fzRefund.body.data.refunds[0].refundNumber).toBe(`RFND/${FY()}/0001`);
    const ph = await refund(v.id, { amountPaise: 100, reason: 'goodwill' });
    expect(ph.body.data.refunds[0].refundNumber).toBe(`RFND/${FY()}/0001`);
    const untouched = await runInTenant(await gymId('powerhouse'), () =>
      Payment.findById(v.id).lean(),
    );
    expect(untouched!.refundedPaise).toBe(100);
  });
});
