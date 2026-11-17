import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog, Member, Membership, Payment, Plan } from '../../src/db/models.js';
import { financialYear, todayIn } from '../../src/lib/dates.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

const { mailer, call, tokenFor, memberToken } = intApp();

const ARJUN = '+919811111111'; // Monthly ₹1,500, ₹500 paid
const PRIYA = '+919811111112'; // Quarterly ₹4,000, expired, unpaid
const VIKRAM = '+919811111113'; // Annual, fully paid
const SURESH = '+919833333331'; // nothing yet

const FY = () => financialYear(todayIn('Asia/Kolkata'));
const key = () => randomUUID();

async function memberId(slug: string, phone: string) {
  return runInTenant(await gymId(slug), async () =>
    String((await Member.findOne({ phone }).lean())!._id),
  );
}
async function membershipOf(slug: string, phone: string) {
  const mid = await memberId(slug, phone);
  return runInTenant(await gymId(slug), async () =>
    String((await Membership.findOne({ memberId: mid }).sort({ startDate: -1 }).lean())!._id),
  );
}
async function planId(slug: string, name: string) {
  return runInTenant(await gymId(slug), async () =>
    String((await Plan.findOne({ name }).lean())!._id),
  );
}
const seq = (receipt: string) => Number(receipt.split('/').at(-1));

describeWithDb('payments (real MongoDB)', () => {
  let owner: string;
  let desk: string;

  beforeAll(async () => {
    await connectTestDb(`payments_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
  });

  const pay = (msid: string, body: object, k: string | null = key(), token = desk, host = PH) => {
    const r = call('post', host, `/memberships/${msid}/payments`, token);
    return (k ? r.set('Idempotency-Key', k) : r).send(body);
  };

  // ---------------------------------------------------------------- recording
  it('records a part payment; balance and status follow; receipt numbered per FY', async () => {
    const arjun = await membershipOf('powerhouse', ARJUN);
    const res = await pay(arjun, { amountPaise: 60000, method: 'upi', reference: 'UPI123456' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      amountPaise: 60000,
      method: 'upi',
      reference: 'UPI123456',
      financialYear: FY(),
      membership: {
        totalPaise: 150000,
        paidPaise: 110000,
        balancePaise: 40000,
        paymentStatus: 'partial',
      },
    });
    expect(res.body.data.receiptNumber).toMatch(new RegExp(`^RCPT/${FY()}/\\d{4}$`));

    const rest = await pay(arjun, { amountPaise: 40000, method: 'cash' });
    expect(rest.body.data.membership).toMatchObject({ balancePaise: 0, paymentStatus: 'paid' });
    expect(seq(rest.body.data.receiptNumber)).toBe(seq(res.body.data.receiptNumber) + 1);

    const log = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.find({ action: 'payment.record' }).lean(),
    );
    expect(log).toHaveLength(2);
  });

  it('refuses more than the balance due, and a refused payment uses no receipt number', async () => {
    const arjun = await membershipOf('powerhouse', ARJUN);
    const over = await pay(arjun, { amountPaise: 100001, method: 'cash' });
    expect(over.status).toBe(422);
    const ok1 = await pay(arjun, { amountPaise: 100000, method: 'cash' });
    const vikram = await membershipOf('powerhouse', VIKRAM);
    expect((await pay(vikram, { amountPaise: 1, method: 'cash' })).status).toBe(422);
    const priya = await membershipOf('powerhouse', PRIYA);
    const ok2 = await pay(priya, { amountPaise: 100000, method: 'card' });
    // Expired memberships can still collect old dues; no gaps despite the refused attempts.
    expect(ok2.status).toBe(201);
    expect(seq(ok2.body.data.receiptNumber)).toBe(seq(ok1.body.data.receiptNumber) + 1);
  });

  it('parallel payments can never exceed the balance', async () => {
    const priya = await membershipOf('powerhouse', PRIYA); // ₹4,000 due
    const results = await Promise.all(
      Array.from({ length: 5 }, () => pay(priya, { amountPaise: 150000, method: 'cash' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 422)).toHaveLength(3);
    const m = await runInTenant(await gymId('powerhouse'), () => Membership.findById(priya).lean());
    expect(m!.paidPaise).toBe(300000);
    const receipts = results
      .filter((r) => r.status === 201)
      .map((r) => seq(r.body.data.receiptNumber));
    expect(Math.abs(receipts[0]! - receipts[1]!)).toBe(1);
  });

  // ---------------------------------------------------------------- idempotency
  it('Idempotency-Key: a retry returns the original payment; reuse for a different payment is refused', async () => {
    const priya = await membershipOf('powerhouse', PRIYA);
    const k = key();
    const first = await pay(priya, { amountPaise: 50000, method: 'cash' }, k);
    const retry = await pay(priya, { amountPaise: 50000, method: 'cash' }, k);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data.receiptNumber).toBe(first.body.data.receiptNumber);
    expect((await pay(priya, { amountPaise: 60000, method: 'cash' }, k)).status).toBe(409);

    const k2 = key();
    const burst = await Promise.all(
      Array.from({ length: 6 }, () => pay(priya, { amountPaise: 10000, method: 'upi' }, k2)),
    );
    expect(burst.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(new Set(burst.map((r) => r.body.data.id)).size).toBe(1);
    const count = await runInTenant(await gymId('powerhouse'), () =>
      Payment.countDocuments({ membershipId: priya }),
    );
    expect(count).toBe(2);
  });

  it('the key is required and validated', async () => {
    const priya = await membershipOf('powerhouse', PRIYA);
    const none = await pay(priya, { amountPaise: 100, method: 'cash' }, null);
    expect(none.status).toBe(422);
    expect(JSON.stringify(none.body)).toMatch(/Idempotency-Key/);
    expect((await pay(priya, { amountPaise: 100, method: 'cash' }, 'short')).status).toBe(422);
  });

  it('422 for bad input: zero, fractional, unknown method, razorpay by hand, future date', async () => {
    const priya = await membershipOf('powerhouse', PRIYA);
    for (const body of [
      { amountPaise: 0, method: 'cash' },
      { amountPaise: 10.5, method: 'cash' },
      { amountPaise: 100, method: 'cheque' },
      { amountPaise: 100, method: 'razorpay' },
      {
        amountPaise: 100,
        method: 'cash',
        receivedAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      { amountPaise: 100, method: 'cash', receivedAt: '2020-01-01' },
    ]) {
      expect((await pay(priya, body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it('cancelled memberships take no payments', async () => {
    const arjun = await membershipOf('powerhouse', ARJUN);
    await call('post', PH, `/memberships/${arjun}/cancel`, desk).send({ reason: 'Moved away' });
    expect((await pay(arjun, { amountPaise: 100, method: 'cash' })).status).toBe(409);
  });

  // ---------------------------------------------------------------- sell + pay
  it('sell and collect in one step: membership, payment and receipt commit together', async () => {
    const suresh = await memberId('powerhouse', SURESH);
    const k = key();
    const body = {
      planId: await planId('powerhouse', 'Quarterly'),
      payment: { amountPaise: 200000, method: 'cash' },
    };
    const res = await call('post', PH, `/members/${suresh}/memberships`, desk)
      .set('Idempotency-Key', k)
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      paidPaise: 200000,
      balancePaise: 200000,
      paymentStatus: 'partial',
    });
    expect(res.body.data.payment.receiptNumber).toMatch(/^RCPT\//);

    const again = await call('post', PH, `/members/${suresh}/memberships`, desk)
      .set('Idempotency-Key', k)
      .send(body);
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(res.body.data.id);

    // Without the key: refused. Payment above the total: refused, and nothing is created.
    const vikram = await memberId('powerhouse', VIKRAM);
    expect(
      (
        await call('post', PH, `/members/${vikram}/memberships/renew`, desk).send({
          payment: { amountPaise: 100, method: 'cash' },
        })
      ).status,
    ).toBe(422);
    const tooMuch = await call('post', PH, `/members/${vikram}/memberships/renew`, desk)
      .set('Idempotency-Key', key())
      .send({ payment: { amountPaise: 1300000, method: 'cash' } });
    expect(tooMuch.status).toBe(422);
    const renewals = await runInTenant(await gymId('powerhouse'), () =>
      Membership.countDocuments({ memberId: vikram }),
    );
    expect(renewals).toBe(1);
  });

  it('an overlapping sale with payment writes neither membership nor payment', async () => {
    const arjun = await memberId('powerhouse', ARJUN);
    const before = await runInTenant(await gymId('powerhouse'), () => Payment.countDocuments());
    const res = await call('post', PH, `/members/${arjun}/memberships`, desk)
      .set('Idempotency-Key', key())
      .send({
        planId: await planId('powerhouse', 'Monthly'),
        payment: { amountPaise: 1000, method: 'cash' },
      });
    expect(res.status).toBe(409);
    expect(await runInTenant(await gymId('powerhouse'), () => Payment.countDocuments())).toBe(
      before,
    );
  });

  // ---------------------------------------------------------------- lists
  it('lists payments with date/method filters and totals; dues list shows what is owed', async () => {
    const priya = await membershipOf('powerhouse', PRIYA);
    await pay(priya, { amountPaise: 100000, method: 'upi' });
    const today = todayIn('Asia/Kolkata');

    const todays = await call('get', PH, `/payments?from=${today}&to=${today}`, desk);
    expect(todays.status).toBe(200);
    expect(todays.body.data).toHaveLength(1);
    expect(todays.body.data[0].member).toMatchObject({ name: 'Priya Nair' });
    expect(todays.body.meta.totals).toEqual({
      receivedPaise: 100000,
      refundedPaise: 0,
      netPaise: 100000,
    });

    const all = await call('get', PH, '/payments', desk);
    expect(all.body.meta.total).toBe(3);
    expect((await call('get', PH, '/payments?method=upi', desk)).body.meta.total).toBe(1);

    const due = await call('get', PH, '/memberships?due=true', desk);
    expect(
      due.body.data
        .map((m: { member: { name: string }; balancePaise: number }) => [
          m.member.name,
          m.balancePaise,
        ])
        .sort(),
    ).toEqual([
      ['Arjun Sharma', 100000],
      ['Priya Nair', 300000],
    ]);

    const mine = await call(
      'get',
      PH,
      `/members/${await memberId('powerhouse', ARJUN)}/payments`,
      desk,
    );
    expect(mine.body.data).toHaveLength(1);
  });

  // ---------------------------------------------------------------- member app
  it('a member sees only their own payments, without staff fields', async () => {
    const arjunMs = await membershipOf('powerhouse', ARJUN);
    await pay(arjunMs, { amountPaise: 1000, method: 'cash', notes: 'Paid by brother' });
    const me = await memberToken(PH, 'arjun@member.demo');
    const res = await call('get', PH, '/members/me/payments', me);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain('brother');
    expect(res.body.data[0]).not.toHaveProperty('receivedBy');
  });

  // ---------------------------------------------------------------- authorization
  it('staff record and read; members and anonymous cannot', async () => {
    const priya = await membershipOf('powerhouse', PRIYA);
    const me = await memberToken(PH, 'arjun@member.demo');
    expect((await pay(priya, { amountPaise: 100, method: 'cash' }, key(), me)).status).toBe(403);
    expect((await call('get', PH, '/payments', me)).status).toBe(403);
    const someone = await memberId('powerhouse', PRIYA);
    expect((await call('get', PH, `/members/${someone}/payments`, me)).status).toBe(403);
    expect((await call('get', PH, '/payments')).status).toBe(401);
    expect((await pay(priya, { amountPaise: 100, method: 'cash' }, key(), owner)).status).toBe(201);
  });

  // ---------------------------------------------------------------- cross-tenant
  it("cross-tenant: FitZone can't pay into, read or number against Powerhouse", async () => {
    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    const phPriya = await membershipOf('powerhouse', PRIYA);
    expect(
      (await pay(phPriya, { amountPaise: 100, method: 'cash' }, key(), fzOwner, FZ)).status,
    ).toBe(404);
    const phPayment = (await call('get', PH, '/payments', desk)).body.data[0].id;
    expect((await call('get', FZ, `/payments/${phPayment}`, fzOwner)).status).toBe(404);
    expect((await call('get', FZ, '/payments', fzOwner)).body.meta.total).toBe(1);

    // The same Idempotency-Key in two gyms is two different payments.
    const k = key();
    const fzSuresh = await memberId('fitzone', '+919833333341');
    const fzSale = await call('post', FZ, `/members/${fzSuresh}/memberships`, fzOwner)
      .set('Idempotency-Key', k)
      .send({
        planId: await planId('fitzone', 'Monthly'),
        payment: { amountPaise: 150000, method: 'upi' },
      });
    expect(fzSale.status).toBe(201);
    const phPay = await pay(phPriya, { amountPaise: 1000, method: 'cash' }, k);
    expect(phPay.status).toBe(201);
    // Each gym numbers its own receipts.
    expect(seq(fzSale.body.data.payment.receiptNumber)).toBeLessThanOrEqual(2);
    expect((await call('get', PH, '/payments', fzOwner)).status).toBe(401);
  });

  it("the gym's receipt prefix is used", async () => {
    await call('patch', PH, '/gym', owner).send({ settings: { receiptPrefix: 'PHF' } });
    const res = await pay(await membershipOf('powerhouse', PRIYA), {
      amountPaise: 100,
      method: 'cash',
    });
    expect(res.body.data.receiptNumber).toMatch(new RegExp(`^PHF/${FY()}/`));
  });
});
