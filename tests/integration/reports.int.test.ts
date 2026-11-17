import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Member, Membership, Plan, User } from '../../src/db/models.js';
import {
  addDays,
  daysBetween,
  formatDateOnly,
  parseDateOnly,
  periodEnd,
  todayIn,
} from '../../src/lib/dates.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

const { mailer, call, tokenFor, memberToken } = intApp();

const today = () => todayIn('Asia/Kolkata');
const day = (n: number) => formatDateOnly(addDays(parseDateOnly(today())!, n))!;
const arjunEnd = () => formatDateOnly(periodEnd(addDays(parseDateOnly(today())!, -25), 1))!;
const ARJUN = '+919811111111';
const PRIYA = '+919811111112';

async function memberId(phone: string) {
  return runInTenant(await gymId('powerhouse'), async () =>
    String((await Member.findOne({ phone }).lean())!._id),
  );
}
async function latestMembership(phone: string) {
  const mid = await memberId(phone);
  return runInTenant(await gymId('powerhouse'), async () =>
    String((await Membership.findOne({ memberId: mid }).sort({ startDate: -1 }).lean())!._id),
  );
}
async function planId(name: string) {
  return runInTenant(await gymId('powerhouse'), async () =>
    String((await Plan.findOne({ name }).lean())!._id),
  );
}

describeWithDb('dashboard and reports (real MongoDB)', () => {
  let owner: string;
  let desk: string;

  beforeAll(async () => {
    await connectTestDb(`reports_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
  });

  const report = (name: string, qs = '', token = owner, host = PH) =>
    call('get', host, `/reports/${name}${qs}`, token);
  const pay = async (phone: string, amountPaise: number, method = 'upi') =>
    call('post', PH, `/memberships/${await latestMembership(phone)}/payments`, desk)
      .set('Idempotency-Key', randomUUID())
      .send({ amountPaise, method });

  // ---------------------------------------------------------------- dashboard
  it('dashboard KPIs from the seed: members, today, renewals, dues', async () => {
    const res = await call('get', PH, '/dashboard', owner);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      date: today(),
      members: { total: 4, active: 2, newThisMonth: 0 },
      attendanceToday: { checkIns: 1, rate: 0.5 },
      pendingRenewals: { expiringSoon: 1, windowDays: 7, recentlyLapsed: 1 },
      dues: { outstandingPaise: 500000, memberships: 2 },
    });
  });

  it('dashboard revenue matches the payments ledger; refunds net out; renewal clears "expiring"', async () => {
    await pay(PRIYA, 100000);
    const p = await pay(ARJUN, 20000, 'cash');
    await call('post', PH, `/payments/${p.body.data.id}/refunds`, owner)
      .set('Idempotency-Key', randomUUID())
      .send({ amountPaise: 5000, reason: 'Overcharged' });

    const dash = (await call('get', PH, '/dashboard', owner)).body.data;
    const monthStart = `${today().slice(0, 7)}-01`;
    const ledger = (await call('get', PH, `/payments?from=${monthStart}&to=${today()}`, owner)).body
      .meta.totals;
    expect(dash.revenue.thisMonth.receivedPaise).toBe(ledger.receivedPaise);
    expect(dash.revenue.thisMonth.refundedPaise).toBe(5000);
    expect(dash.revenue.thisMonth.netPaise).toBe(ledger.receivedPaise - 5000);
    expect(dash.dues.outstandingPaise).toBe(500000 - 120000 + 5000);

    await call('post', PH, `/members/${await memberId(ARJUN)}/memberships/renew`, desk).send({});
    expect(
      (await call('get', PH, '/dashboard', owner)).body.data.pendingRenewals.expiringSoon,
    ).toBe(0);
  });

  it('new members this month count registrations dated this month', async () => {
    await call('post', PH, '/members', desk).send({
      name: 'New One',
      phone: '9876512345',
      consent: true,
    });
    expect((await call('get', PH, '/dashboard', owner)).body.data.members).toMatchObject({
      total: 5,
      newThisMonth: 1,
    });
  });

  // ---------------------------------------------------------------- revenue
  it('revenue: per-day series with zero days, method split, and the same total for any grouping', async () => {
    await pay(PRIYA, 10000);
    const p = await pay(PRIYA, 3000, 'cash');
    await call('post', PH, `/payments/${p.body.data.id}/refunds`, owner)
      .set('Idempotency-Key', randomUUID())
      .send({ amountPaise: 2000, reason: 'Wrong amount' });

    const r = (await report('revenue', `?from=${day(-39)}&to=${today()}&groupBy=day`)).body.data;
    expect(r.series).toHaveLength(40);
    // Seed: Vikram ₹12,000 (30 days ago), Arjun ₹500 (25 days ago); today ₹100 UPI + ₹30 cash − ₹20 refund.
    expect(r.series.find((x: { period: string }) => x.period === day(-30))).toMatchObject({
      receivedPaise: 1200000,
      payments: 1,
    });
    expect(r.series.at(-1)).toMatchObject({
      period: today(),
      receivedPaise: 13000,
      refundedPaise: 2000,
      netPaise: 11000,
    });
    expect(r.totals).toMatchObject({
      receivedPaise: 1263000,
      refundedPaise: 2000,
      netPaise: 1261000,
      payments: 4,
      refunds: 1,
    });
    expect(r.byMethod).toEqual({
      cash: { receivedPaise: 1253000, payments: 3 },
      upi: { receivedPaise: 10000, payments: 1 },
    });

    for (const by of ['week', 'month']) {
      const g = (await report('revenue', `?from=${day(-39)}&to=${today()}&groupBy=${by}`)).body
        .data;
      expect(g.totals.netPaise, by).toBe(1261000);
    }
  });

  // ---------------------------------------------------------------- memberships
  it('memberships: sold by kind and plan, discounts, cancellations', async () => {
    await call('post', PH, `/members/${await memberId(ARJUN)}/memberships/renew`, desk).send({
      discountPaise: 20000,
    });
    const suresh = await runInTenant(await gymId('powerhouse'), async () =>
      String((await Member.findOne({ phone: '+919833333331' }).lean())!._id),
    );
    const sale = await call('post', PH, `/members/${suresh}/memberships`, desk).send({
      planId: await planId('Quarterly'),
    });
    await call('post', PH, `/memberships/${sale.body.data.id}/cancel`, desk).send({
      reason: 'Changed mind',
    });

    const r = (await report('memberships', `?from=${today()}&to=${today()}`)).body.data;
    // Seed memberships are created "today" too (3 new); plus 1 renewal and 1 new sale.
    expect(r.totals).toMatchObject({
      sold: 5,
      new: 4,
      renewals: 1,
      discountPaise: 20000,
      cancelled: 1,
    });
    expect(r.byPlan.find((p: { plan: string }) => p.plan === 'Monthly')).toMatchObject({
      sold: 2,
      valuePaise: 280000,
    });
  });

  // ---------------------------------------------------------------- attendance
  it('attendance: totals, unique members, per-day average, hours and weekdays', async () => {
    const r = (await report('attendance', `?from=${day(-6)}&to=${today()}`)).body.data;
    expect(r.groupBy).toBe('day');
    expect(r.totals).toEqual({ checkIns: 4, uniqueMembers: 2, averagePerDay: 0.6 });
    expect(r.series.map((s: { checkIns: number }) => s.checkIns)).toEqual([0, 0, 0, 0, 1, 2, 1]);
    expect(r.byHour[7].checkIns).toBe(4);
    expect(r.byWeekday.reduce((a: number, w: { checkIns: number }) => a + w.checkIns, 0)).toBe(4);
  });

  // ---------------------------------------------------------------- growth
  it('growth: joined/archived per period; totals and active members at each period end', async () => {
    await call('post', PH, '/members', desk).send({
      name: 'Late Joiner',
      phone: '9876500077',
      consent: true,
      joinDate: day(-10),
    });
    await call('post', PH, `/members/${await memberId(PRIYA)}/archive`, owner);
    const r = (await report('growth', `?from=${day(-20)}&to=${today()}&groupBy=day`)).body.data;
    expect(r.totals).toEqual({ joined: 1, archived: 1, netChange: 0 });
    const at = (d: string) => r.series.find((s: { period: string }) => s.period === d);
    expect(at(day(-11))).toMatchObject({ totalMembers: 4 });
    expect(at(day(-10))).toMatchObject({ joined: 1, totalMembers: 5 });
    expect(at(today())).toMatchObject({ archived: 1, totalMembers: 4, activeMembers: 2 });
  });

  // ---------------------------------------------------------------- renewals
  it('renewals: on time, late, not renewed, pending, and the rate', async () => {
    const qs = `?from=${day(-40)}&to=${day(10)}&groupBy=day`;
    let r = (await report('renewals', qs)).body.data;
    // Priya ended ~10 days ago (not renewed); Arjun ends in a few days (pending).
    expect(r.totals).toMatchObject({
      ending: 2,
      notRenewed: 1,
      pending: 1,
      renewedOnTime: 0,
      renewedLate: 0,
      renewalRate: 0,
    });

    await call('post', PH, `/members/${await memberId(ARJUN)}/memberships/renew`, desk).send({});
    await call('post', PH, `/members/${await memberId(PRIYA)}/memberships/renew`, desk).send({
      startFrom: 'today',
    });
    r = (await report('renewals', qs)).body.data;
    expect(r.totals).toMatchObject({
      ending: 2,
      renewedOnTime: 1,
      renewedLate: 1,
      notRenewed: 0,
      pending: 0,
      renewalRate: 1,
    });
    const arjunRow = r.series.find((s: { period: string }) => s.period === arjunEnd());
    expect(arjunRow).toMatchObject({ ending: 1, renewedOnTime: 1, renewalRate: 1 });
    expect(daysBetween(parseDateOnly(today())!, parseDateOnly(arjunEnd())!)).toBeGreaterThanOrEqual(
      0,
    );
  });

  // ---------------------------------------------------------------- validation
  it('422 for reversed or too-long ranges, impossible dates and bad grouping; defaults to the last 30 days', async () => {
    expect((await report('revenue', `?from=${today()}&to=${day(-1)}`)).status).toBe(422);
    expect((await report('revenue', `?from=${day(-400)}&to=${today()}`)).status).toBe(422);
    expect((await report('revenue', '?from=2026-02-30')).status).toBe(422);
    expect((await report('revenue', '?groupBy=year')).status).toBe(422);
    const def = (await report('attendance')).body.data;
    expect(def).toMatchObject({ from: day(-29), to: today(), groupBy: 'day' });
    expect(def.series).toHaveLength(30);
  });

  // ---------------------------------------------------------------- authorization
  it('desk sees the dashboard without revenue and no reports, unless granted reports:read', async () => {
    const d = await call('get', PH, '/dashboard', desk);
    expect(d.status).toBe(200);
    expect(d.body.data.revenue).toBeNull();
    expect((await report('revenue', '', desk)).status).toBe(403);
    const deskId = await runInTenant(await gymId('powerhouse'), async () =>
      String((await User.findOne({ email: 'desk@powerhouse.demo' }).lean())!._id),
    );
    await call('patch', PH, `/staff/${deskId}`, owner).send({ permissions: ['reports:read'] });
    expect((await call('get', PH, '/dashboard', desk)).body.data.revenue).not.toBeNull();
    expect((await report('renewals', '', desk)).status).toBe(200);

    const member = await memberToken(PH, 'arjun@member.demo');
    expect((await call('get', PH, '/dashboard', member)).status).toBe(403);
    expect((await report('revenue', '', member)).status).toBe(403);
    expect((await call('get', PH, '/dashboard')).status).toBe(401);
  });

  // ---------------------------------------------------------------- cross-tenant
  it("cross-tenant: every figure is the host gym's own", async () => {
    const fz = await tokenFor(FZ, 'owner@fitzone.demo');
    const d = (await call('get', FZ, '/dashboard', fz)).body.data;
    expect(d).toMatchObject({
      members: { total: 4, active: 1 },
      attendanceToday: { checkIns: 1 },
      dues: { outstandingPaise: 0 },
    });
    const rev = (await report('revenue', `?from=${day(-40)}&to=${today()}`, fz, FZ)).body.data;
    expect(rev.totals.receivedPaise).toBe(400000); // FitZone's Arjun, Quarterly, no GST
    expect(rev.byMethod).toEqual({ upi: { receivedPaise: 400000, payments: 1 } });
    expect(
      (await report('attendance', `?from=${day(-6)}&to=${today()}`, fz, FZ)).body.data.totals
        .checkIns,
    ).toBe(1);
    expect((await call('get', PH, '/dashboard', fz)).status).toBe(401);
  });
});
