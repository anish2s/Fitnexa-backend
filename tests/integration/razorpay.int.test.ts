import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  AuditLog,
  GatewayAlert,
  Member,
  Membership,
  Payment,
  Tenant,
} from '../../src/db/models.js';
import { RazorpayError, type RazorpayClient } from '../../src/modules/payments/razorpay.client.js';
import { runAsPlatform, runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, PLATFORM, gymId, intApp, resetDemo } from '../helpers/int.js';

/** Fake Razorpay: records calls, never touches the network. */
const rp = {
  orders: [] as { keySecret: string; amountPaise: number }[],
  refunds: [] as { paymentId: string; amountPaise: number }[],
  failRefund: false,
  refundStatus: 'processed' as 'processed' | 'pending',
  reset() {
    this.orders = [];
    this.refunds = [];
    this.failRefund = false;
    this.refundStatus = 'processed';
  },
};
const fakeRazorpay: RazorpayClient = {
  async createOrder(creds, o) {
    rp.orders.push({ keySecret: creds.keySecret, amountPaise: o.amountPaise });
    return {
      id: `order_${randomBytes(8).toString('hex')}`,
      amount: o.amountPaise,
      currency: 'INR',
      status: 'created',
    };
  },
  async refund(_creds, r) {
    if (rp.failRefund) throw new RazorpayError('The amount is invalid', 400, 'BAD_REQUEST_ERROR');
    rp.refunds.push({ paymentId: r.paymentId, amountPaise: r.amountPaise });
    return {
      id: `rfnd_${randomBytes(8).toString('hex')}`,
      amount: r.amountPaise,
      status: rp.refundStatus,
    };
  },
};

const MASTER = randomBytes(32).toString('base64');
const { mailer, call, tokenFor, memberToken } = intApp(
  { PAYMENTS_ENCRYPTION_KEY: MASTER },
  null,
  fakeRazorpay,
);
const noKeyApp = intApp({}, null, fakeRazorpay);

const KEYS = {
  keyId: 'rzp_test_AbCdEf123456',
  keySecret: 'KeySecretValue1234567890',
  webhookSecret: 'whsec-powerhouse-1',
};
const hmac = (data: string, secret: string) =>
  createHmac('sha256', secret).update(data).digest('hex');
const payId = () => `pay_${randomBytes(7).toString('hex')}`;

async function membershipOf(phone: string, slug = 'powerhouse') {
  return runInTenant(await gymId(slug), async () => {
    const m = await Member.findOne({ phone }).lean();
    return String(
      (await Membership.findOne({ memberId: m!._id }).sort({ startDate: -1 }).lean())!._id,
    );
  });
}
const ARJUN = '+919811111111'; // ₹1,500, ₹500 paid → ₹1,000 due
const PRIYA = '+919811111112'; // ₹4,000 due
const VIKRAM = '+919811111113'; // fully paid

describeWithDb('Razorpay (test mode, fake gateway, real MongoDB)', () => {
  let owner: string;
  let desk: string;

  beforeAll(async () => {
    await connectTestDb(`razorpay_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    rp.reset();
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
  });

  const connect = (token = owner, host = PH, keys = KEYS) =>
    call('put', host, '/gym/payment-gateway/razorpay', token).send(keys);
  const order = (msid: string, body: object = {}, token = desk) =>
    call('post', PH, `/memberships/${msid}/razorpay-order`, token).send(body);
  const verify = (orderId: string, paymentId: string, token = desk, secret = KEYS.keySecret) =>
    call('post', PH, '/payments/razorpay/verify', token).send({
      orderId,
      paymentId,
      signature: hmac(`${orderId}|${paymentId}`, secret),
    });
  const webhook = (
    body: object,
    opts: { secret?: string; eventId?: string; host?: string } = {},
  ) => {
    const raw = JSON.stringify(body);
    return call('post', opts.host ?? PH, '/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', hmac(raw, opts.secret ?? KEYS.webhookSecret))
      .set('X-Razorpay-Event-Id', opts.eventId ?? `evt_${randomUUID()}`)
      .send(raw);
  };
  const captured = (orderId: string, paymentId: string, amount: number) => ({
    event: 'payment.captured',
    payload: {
      payment: { entity: { id: paymentId, order_id: orderId, amount, status: 'captured' } },
    },
  });

  // ---------------------------------------------------------------- connecting
  it('owner connects test keys: stored encrypted, secrets never returned or logged', async () => {
    const before = await call('get', PH, '/gym/payment-gateway', owner);
    expect(before.body.data).toMatchObject({
      available: true,
      razorpay: {
        connected: false,
        webhookUrl: 'http://powerhouse.localhost:3000/api/v1/webhooks/razorpay',
      },
    });
    const res = await connect();
    expect(res.status).toBe(200);
    expect(res.body.data.razorpay).toMatchObject({
      connected: true,
      keyId: KEYS.keyId,
      mode: 'test',
    });
    expect(JSON.stringify(res.body)).not.toContain(KEYS.keySecret);
    expect(JSON.stringify(res.body)).not.toContain(KEYS.webhookSecret);

    const stored = await runAsPlatform('test', () =>
      Tenant.findOne({ slug: 'powerhouse' })
        .select('+razorpay.keySecretEnc +razorpay.webhookSecretEnc')
        .lean(),
    );
    expect(stored!.razorpay!.keySecretEnc).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain(KEYS.keySecret);
    // Default reads never even load the ciphertext.
    const plain = await runAsPlatform('test', () => Tenant.findOne({ slug: 'powerhouse' }).lean());
    expect(plain!.razorpay).not.toHaveProperty('keySecretEnc');

    const logs = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.find({ action: 'gym.payment_gateway_update' }).lean(),
    );
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(KEYS.keySecret);
  });

  it('live keys are refused unless the server allows them; bad formats are 422', async () => {
    const live = await connect(owner, PH, { ...KEYS, keyId: 'rzp_live_AbCdEf123456' });
    expect(live.status).toBe(422);
    expect(JSON.stringify(live.body)).toMatch(/Live keys are not enabled/);
    for (const keys of [
      { ...KEYS, keyId: 'pk_test_123456789' },
      { ...KEYS, keySecret: 'short' },
      { ...KEYS, webhookSecret: '' },
    ]) {
      expect((await connect(owner, PH, keys)).status).toBe(422);
    }
  });

  it('only the owner (not staff, not an impersonating super admin) can see or change keys', async () => {
    expect((await connect(desk)).status).toBe(403);
    expect((await call('get', PH, '/gym/payment-gateway', desk)).status).toBe(403);
    const admin = await tokenFor(PLATFORM, 'admin@platform.demo');
    const id = await gymId('powerhouse');
    const imp = await call('post', PLATFORM, `/platform/tenants/${id}/impersonate`, admin).send({
      reason: 'Support ticket 4521',
    });
    const impToken = imp.body.data.accessToken as string;
    expect((await connect(impToken)).status).toBe(403);
    expect((await call('delete', PH, '/gym/payment-gateway/razorpay', impToken)).status).toBe(403);
  });

  it('without a server encryption key: 503 for connecting; desk payments still work', async () => {
    const t = await noKeyApp.tokenFor(PH, 'owner@powerhouse.demo');
    const res = await noKeyApp.call('put', PH, '/gym/payment-gateway/razorpay', t).send(KEYS);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYMENT_GATEWAY_NOT_CONFIGURED');
    const pay = await noKeyApp
      .call('post', PH, `/memberships/${await membershipOf(PRIYA)}/payments`, t)
      .set('Idempotency-Key', randomUUID())
      .send({ amountPaise: 100, method: 'cash' });
    expect(pay.status).toBe(201);
  });

  // ---------------------------------------------------------------- checkout
  it('desk checkout: order for the balance, verified payment recorded once', async () => {
    expect((await order(await membershipOf(ARJUN))).status).toBe(409); // not connected yet
    await connect();
    const arjun = await membershipOf(ARJUN);
    const o = await order(arjun);
    expect(o.status).toBe(201);
    expect(o.body.data).toMatchObject({
      keyId: KEYS.keyId,
      amountPaise: 100000,
      currency: 'INR',
      name: 'Powerhouse Fitness',
      prefill: { name: 'Arjun Sharma' },
    });
    expect(JSON.stringify(o.body)).not.toContain(KEYS.keySecret);
    expect(rp.orders[0]).toEqual({ keySecret: KEYS.keySecret, amountPaise: 100000 });

    const pid = payId();
    const v = await verify(o.body.data.orderId, pid);
    expect(v.status).toBe(201);
    expect(v.body.data).toMatchObject({
      method: 'razorpay',
      amountPaise: 100000,
      reference: pid,
      gateway: { paymentId: pid },
    });
    expect(v.body.data.receiptNumber).toMatch(/^RCPT\//);
    const again = await verify(o.body.data.orderId, pid);
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(v.body.data.id);
    const ms = await runInTenant(await gymId('powerhouse'), () =>
      Membership.findById(arjun).lean(),
    );
    expect(ms!.paidPaise).toBe(150000);
  });

  it('a forged or mismatched signature records nothing', async () => {
    await connect();
    const o = await order(await membershipOf(PRIYA));
    const bad = await verify(o.body.data.orderId, payId(), desk, 'not-the-secret-at-all');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_SIGNATURE');
    const swapped = await call('post', PH, '/payments/razorpay/verify', desk).send({
      orderId: o.body.data.orderId,
      paymentId: payId(),
      signature: hmac(`${o.body.data.orderId}|pay_someoneElse1`, KEYS.keySecret),
    });
    expect(swapped.status).toBe(400);
    expect(
      await runInTenant(await gymId('powerhouse'), () =>
        Payment.countDocuments({ method: 'razorpay' }),
      ),
    ).toBe(0);
  });

  it('order rules: not above balance, nothing due, cancelled', async () => {
    await connect();
    expect((await order(await membershipOf(ARJUN), { amountPaise: 100001 })).status).toBe(422);
    expect(
      (await order(await membershipOf(ARJUN), { amountPaise: 50000 })).body.data.amountPaise,
    ).toBe(50000);
    expect((await order(await membershipOf(VIKRAM))).status).toBe(409);
    const arjun = await membershipOf(ARJUN);
    await call('post', PH, `/memberships/${arjun}/cancel`, desk).send({ reason: 'test cancel' });
    expect((await order(arjun)).status).toBe(409);
  });

  // ---------------------------------------------------------------- member self-pay
  it('a member pays their own balance from the app, and only their own', async () => {
    await connect();
    const me = await memberToken(PH, 'arjun@member.demo');
    const own = await call(
      'post',
      PH,
      `/members/me/memberships/${await membershipOf(ARJUN)}/razorpay-order`,
      me,
    ).send({});
    expect(own.status).toBe(201);
    const other = await call(
      'post',
      PH,
      `/members/me/memberships/${await membershipOf(PRIYA)}/razorpay-order`,
      me,
    ).send({});
    expect(other.status).toBe(404);
    // Can't use the desk endpoint, can't complete someone else's order.
    expect((await order(await membershipOf(PRIYA), {}, me)).status).toBe(403);
    const deskOrder = await order(await membershipOf(PRIYA));
    expect((await verify(deskOrder.body.data.orderId, payId(), me)).status).toBe(404);

    const v = await verify(own.body.data.orderId, payId(), me);
    expect(v.status).toBe(201);
    expect(v.body.data).not.toHaveProperty('receivedBy');
    const mine = await call('get', PH, '/members/me/payments', me);
    expect(mine.body.data.some((p: { method: string }) => p.method === 'razorpay')).toBe(true);
  });

  // ---------------------------------------------------------------- webhooks
  it('webhook: signed payment.captured records the payment; browser verify later is a no-op', async () => {
    await connect();
    const o = await order(await membershipOf(PRIYA));
    const pid = payId();
    const w = await webhook(captured(o.body.data.orderId, pid, 400000));
    expect(w.status).toBe(200);
    expect(w.body.data.status).toBe('captured');
    const v = await verify(o.body.data.orderId, pid);
    expect(v.status).toBe(200);
    expect(
      await runInTenant(await gymId('powerhouse'), () =>
        Payment.countDocuments({ 'gateway.paymentId': pid }),
      ),
    ).toBe(1);
    const log = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.findOne({ action: 'payment.record', 'metadata.razorpayPaymentId': pid }).lean(),
    );
    expect(log!.actor).toMatchObject({ type: 'system' });
  });

  it('webhook: retries with the same event id are acknowledged once; bad signatures rejected', async () => {
    await connect();
    const o = await order(await membershipOf(PRIYA));
    const body = captured(o.body.data.orderId, payId(), 400000);
    const first = await webhook(body, { eventId: 'evt_same_1' });
    const second = await webhook(body, { eventId: 'evt_same_1' });
    expect(first.body.data.status).toBe('captured');
    expect(second.body.data.status).toBe('duplicate');
    const forged = await webhook(captured(o.body.data.orderId, payId(), 400000), {
      secret: 'wrong-secret-x',
    });
    expect(forged.status).toBe(400);
    const unsigned = await call('post', PH, '/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(unsigned.status).toBe(400);
    expect(
      await runInTenant(await gymId('powerhouse'), () =>
        Payment.countDocuments({ method: 'razorpay' }),
      ),
    ).toBe(1);
  });

  it('webhook signature is checked over the raw bytes, not re-serialised JSON', async () => {
    await connect();
    const o = await order(await membershipOf(PRIYA));
    const body = captured(o.body.data.orderId, payId(), 400000);
    // Same JSON value, different bytes than JSON.stringify(body) would produce.
    const pretty = JSON.stringify(body, null, 2) + '\n';
    const send = (raw: string, signedOver: string) =>
      call('post', PH, '/webhooks/razorpay')
        .set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', hmac(signedOver, KEYS.webhookSecret))
        .set('X-Razorpay-Event-Id', `evt_${randomUUID()}`)
        .send(raw);
    // Signed over the compact form but delivered pretty: a re-serialising verifier would accept it.
    expect((await send(pretty, JSON.stringify(body))).status).toBe(400);
    const ok = await send(pretty, pretty);
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('captured');
  });

  it('webhook: unknown orders are acknowledged and ignored; unconnected gyms 404', async () => {
    await connect();
    const w = await webhook(captured('order_notOurs123', payId(), 1000));
    expect(w.status).toBe(200);
    expect(w.body.data.status).toBe('ignored');
    expect((await webhook(captured('order_x1234567', payId(), 1), { host: FZ })).status).toBe(404);
  });

  it('a gateway payment that arrives after the desk already collected shows as overpaid', async () => {
    await connect();
    const arjun = await membershipOf(ARJUN);
    const o = await order(arjun);
    await call('post', PH, `/memberships/${arjun}/payments`, desk)
      .set('Idempotency-Key', randomUUID())
      .send({ amountPaise: 100000, method: 'cash' });
    await webhook(captured(o.body.data.orderId, payId(), 100000));
    const res = await call(
      'get',
      PH,
      `/members/${(await runInTenant(await gymId('powerhouse'), () => Membership.findById(arjun).lean()))!.memberId}/memberships`,
      desk,
    );
    expect(res.body.data.items[0]).toMatchObject({
      paymentStatus: 'overpaid',
      balancePaise: -100000,
    });
  });

  // ---------------------------------------------------------------- duplicate payments
  const phGym = async <T>(fn: () => Promise<T>) => runInTenant(await gymId('powerhouse'), fn);
  const membershipState = (id: string) =>
    phGym(async () => {
      const m = (await Membership.findById(id).lean())!;
      return { paidPaise: m.paidPaise, endDate: m.endDate, totalPaise: m.totalPaise };
    });

  it('a second payment on a paid order is not applied: duplicate_refund_due, audited, no refund', async () => {
    await connect();
    const priya = await membershipOf(PRIYA);
    const o = await order(priya);
    const first = payId();
    expect((await verify(o.body.data.orderId, first)).status).toBe(201);
    const paid = await membershipState(priya);

    const second = payId();
    const v = await verify(o.body.data.orderId, second);
    expect(v.status).toBe(409);
    expect(v.body.error.code).toBe('DUPLICATE_PAYMENT');
    // The webhook for the same second payment, and a retry of it, add nothing more.
    const w = await webhook(captured(o.body.data.orderId, second, 400000));
    expect(w.status).toBe(200);
    expect(w.body.data.status).toBe('duplicate_refund_due');
    expect((await verify(o.body.data.orderId, second)).status).toBe(409);
    // The webhook for the FIRST payment is still just the same payment, not a duplicate.
    const w1 = await webhook(captured(o.body.data.orderId, first, 400000));
    expect(w1.body.data.status).toBe('captured');

    expect(await membershipState(priya)).toEqual(paid);
    expect(await phGym(() => Payment.countDocuments({ method: 'razorpay' }))).toBe(1);
    const alerts = await phGym(() => GatewayAlert.find().lean());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      status: 'duplicate_refund_due',
      razorpayPaymentId: second,
      appliedRazorpayPaymentId: first,
      amountPaise: 400000,
      source: 'checkout',
    });
    const logs = await phGym(() =>
      AuditLog.find({ action: 'payment.duplicate_gateway_payment' }).lean(),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.metadata).toMatchObject({ razorpayPaymentId: second, amountPaise: 400000 });
    expect(rp.refunds).toEqual([]); // nothing refunded automatically
  });

  it('webhook-only: the second captured payment on a paid order becomes an alert', async () => {
    await connect();
    const arjun = await membershipOf(ARJUN);
    const o = await order(arjun);
    expect((await webhook(captured(o.body.data.orderId, payId(), 100000))).body.data.status).toBe(
      'captured',
    );
    const paid = await membershipState(arjun);
    const w = await webhook(captured(o.body.data.orderId, payId(), 100000));
    expect(w.body.data.status).toBe('duplicate_refund_due');
    expect(await membershipState(arjun)).toEqual(paid);
    expect(await phGym(() => GatewayAlert.countDocuments({ source: 'webhook' }))).toBe(1);
  });

  it('concurrent: two different payments for one order apply once; the same payment twice is not a duplicate', async () => {
    await connect();
    const priya = await membershipOf(PRIYA);
    const o = await order(priya);
    const [a, b] = [payId(), payId()];
    await Promise.all([
      verify(o.body.data.orderId, a),
      webhook(captured(o.body.data.orderId, b, 400000)),
      verify(o.body.data.orderId, b),
      webhook(captured(o.body.data.orderId, a, 400000)),
    ]);
    expect(await phGym(() => Payment.countDocuments({ method: 'razorpay' }))).toBe(1);
    expect((await membershipState(priya)).paidPaise).toBe(400000);
    const alerts = await phGym(() => GatewayAlert.find().lean());
    expect(alerts).toHaveLength(1);
    const applied = (await phGym(() => Payment.findOne({ method: 'razorpay' }).lean()))!;
    expect([a, b]).toContain(applied.gateway!.paymentId);
    expect(alerts[0]!.razorpayPaymentId).not.toBe(applied.gateway!.paymentId);
  });

  async function duplicateOnPriya() {
    await connect();
    const o = await order(await membershipOf(PRIYA));
    await verify(o.body.data.orderId, payId());
    await webhook(captured(o.body.data.orderId, payId(), 400000));
    return (await phGym(() => GatewayAlert.findOne().lean()))!;
  }

  it('owner sees open alerts (list + dashboard count) and resolves one after refunding in Razorpay', async () => {
    const alert = await duplicateOnPriya();
    const list = await call('get', PH, '/gym/payment-gateway/alerts', owner);
    expect(list.status).toBe(200);
    expect(list.body.data.openCount).toBe(1);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0]).toMatchObject({
      id: String(alert._id),
      kind: 'duplicate_payment',
      status: 'duplicate_refund_due',
      amountPaise: 400000,
      memberName: expect.any(String),
    });
    const dash = await call('get', PH, '/dashboard', owner);
    expect(dash.body.data.alerts).toEqual({ duplicatePaymentsRefundDue: 1 });

    const path = `/gym/payment-gateway/alerts/${alert._id}/resolve`;
    expect((await call('post', PH, path, owner).send({})).status).toBe(422);
    expect(
      (
        await call('post', PH, '/gym/payment-gateway/alerts/not-an-id/resolve', owner).send({
          note: 'Refunded',
        })
      ).status,
    ).toBe(422);
    expect((await call('get', PH, '/gym/payment-gateway/alerts?status=bogus', owner)).status).toBe(
      422,
    );
    const res = await call('post', PH, path, owner).send({ note: 'Refunded in Razorpay rfnd_1' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'resolved',
      resolutionNote: 'Refunded in Razorpay rfnd_1',
    });
    expect((await call('post', PH, path, owner).send({ note: 'again' })).status).toBe(409);

    const after = await call('get', PH, '/gym/payment-gateway/alerts', owner);
    expect(after.body.data).toMatchObject({ openCount: 0, items: [] });
    const all = await call('get', PH, '/gym/payment-gateway/alerts?status=all', owner);
    expect(all.body.data.items).toHaveLength(1);
    expect((await call('get', PH, '/dashboard', owner)).body.data.alerts).toEqual({
      duplicatePaymentsRefundDue: 0,
    });
    expect(
      await phGym(() =>
        AuditLog.countDocuments({ action: 'payment.duplicate_gateway_payment_resolve' }),
      ),
    ).toBe(1);
  });

  it('alerts: front desk and members are refused; signed-out is 401; FitZone sees none of them', async () => {
    const alert = await duplicateOnPriya();
    const path = `/gym/payment-gateway/alerts/${alert._id}/resolve`;
    const me = await memberToken(PH, 'arjun@member.demo');
    for (const token of [desk, me]) {
      expect((await call('get', PH, '/gym/payment-gateway/alerts', token)).status).toBe(403);
      expect((await call('post', PH, path, token).send({ note: 'Refunded' })).status).toBe(403);
    }
    expect((await call('get', PH, '/gym/payment-gateway/alerts')).status).toBe(401);
    // Front desk's dashboard has no alerts block (refunds are not theirs to act on).
    expect((await call('get', PH, '/dashboard', desk)).body.data.alerts).toBeNull();

    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    const fzList = await call('get', FZ, '/gym/payment-gateway/alerts?status=all', fzOwner);
    expect(fzList.body.data).toMatchObject({ openCount: 0, items: [] });
    expect((await call('post', FZ, path, fzOwner).send({ note: 'Refunded' })).status).toBe(404);
    // A Powerhouse token on the FitZone host is refused before anything is read.
    expect((await call('get', FZ, '/gym/payment-gateway/alerts', owner)).status).toBe(401);
    expect((await phGym(() => GatewayAlert.findById(alert._id).lean()))!.status).toBe(
      'duplicate_refund_due',
    );
  });

  // ---------------------------------------------------------------- gateway refunds
  async function paidOnline() {
    await connect();
    const o = await order(await membershipOf(PRIYA));
    const pid = payId();
    const v = await verify(o.body.data.orderId, pid);
    return { id: v.body.data.id as string, pid };
  }
  const refund = (id: string, amountPaise: number) =>
    call('post', PH, `/payments/${id}/refunds`, owner)
      .set('Idempotency-Key', randomUUID())
      .send({ amountPaise, reason: 'Customer request' });

  it('refunds an online payment through Razorpay', async () => {
    const { id, pid } = await paidOnline();
    const res = await refund(id, 150000);
    expect(res.status).toBe(201);
    expect(res.body.data.refunds[0]).toMatchObject({
      method: 'gateway',
      status: 'processed',
      amountPaise: 150000,
    });
    expect(rp.refunds).toEqual([{ paymentId: pid, amountPaise: 150000 }]);
    expect(res.body.data.membership.paidPaise).toBe(250000);
  });

  it('if Razorpay refuses, nothing is refunded in our books (502, reverted)', async () => {
    const { id } = await paidOnline();
    rp.failRefund = true;
    const res = await refund(id, 150000);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_GATEWAY_ERROR');
    const p = await runInTenant(await gymId('powerhouse'), () => Payment.findById(id).lean());
    expect(p!.refundedPaise).toBe(0);
    expect(p!.refunds[0]!.status).toBe('failed');
    const m = await runInTenant(await gymId('powerhouse'), () =>
      Membership.findById(p!.membershipId).lean(),
    );
    expect(m!.paidPaise).toBe(400000);
  });

  it('pending gateway refunds settle by webhook: processed, or failed and reverted', async () => {
    const { id } = await paidOnline();
    rp.refundStatus = 'pending';
    await refund(id, 100000);
    await refund(id, 50000);
    let p = await runInTenant(await gymId('powerhouse'), () => Payment.findById(id).lean());
    const [r1, r2] = p!.refunds;
    expect([r1!.status, r2!.status]).toEqual(['pending', 'pending']);
    expect(p!.refundedPaise).toBe(150000);

    await webhook({
      event: 'refund.processed',
      payload: {
        refund: { entity: { id: r1!.gatewayRefundId, amount: 100000, status: 'processed' } },
      },
    });
    await webhook({
      event: 'refund.failed',
      payload: { refund: { entity: { id: r2!.gatewayRefundId, amount: 50000, status: 'failed' } } },
    });
    p = await runInTenant(await gymId('powerhouse'), () => Payment.findById(id).lean());
    expect(p!.refunds.map((r) => r.status)).toEqual(['processed', 'failed']);
    expect(p!.refundedPaise).toBe(100000);
    // A repeated refund.failed doesn't revert twice.
    await webhook({
      event: 'refund.failed',
      payload: { refund: { entity: { id: r2!.gatewayRefundId } } },
    });
    p = await runInTenant(await gymId('powerhouse'), () => Payment.findById(id).lean());
    expect(p!.refundedPaise).toBe(100000);
  });

  // ---------------------------------------------------------------- cross-tenant
  it("cross-tenant: FitZone's keys, orders and webhooks never touch Powerhouse", async () => {
    await connect();
    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    await connect(fzOwner, FZ, {
      ...KEYS,
      keyId: 'rzp_test_FitZone12345',
      webhookSecret: 'whsec-fitzone-1',
    });
    const phPriya = await membershipOf(PRIYA);
    expect(
      (await call('post', FZ, `/memberships/${phPriya}/razorpay-order`, fzOwner).send({})).status,
    ).toBe(404);

    const phOrder = await order(phPriya);
    // FitZone desk can't complete a Powerhouse order, even with a valid Powerhouse signature.
    expect(
      (
        await call('post', FZ, '/payments/razorpay/verify', fzOwner).send({
          orderId: phOrder.body.data.orderId,
          paymentId: 'pay_cross12345',
          signature: hmac(`${phOrder.body.data.orderId}|pay_cross12345`, KEYS.keySecret),
        })
      ).status,
    ).toBe(404);
    // A Powerhouse-signed webhook sent to FitZone fails FitZone's secret.
    expect(
      (await webhook(captured(phOrder.body.data.orderId, payId(), 400000), { host: FZ })).status,
    ).toBe(400);
    // Even FitZone-signed, it names an order FitZone never created: ignored.
    const w = await webhook(captured(phOrder.body.data.orderId, payId(), 400000), {
      host: FZ,
      secret: 'whsec-fitzone-1',
    });
    expect(w.body.data.status).toBe('ignored');
    expect(
      await runInTenant(await gymId('powerhouse'), () =>
        Payment.countDocuments({ method: 'razorpay' }),
      ),
    ).toBe(0);
    expect(
      await runInTenant(await gymId('fitzone'), () =>
        Payment.countDocuments({ method: 'razorpay' }),
      ),
    ).toBe(0);
  });
});
