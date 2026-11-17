import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog, Member, Membership, Plan, User } from '../../src/db/models.js';
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

const ARJUN = '+919811111111'; // Monthly, started 25 days ago: ends in a few days
const PRIYA = '+919811111112'; // Quarterly, started 100 days ago: expired
const VIKRAM = '+919811111113'; // Annual, started 30 days ago
const SURESH = '+919833333331'; // no membership, no email

const today = () => parseDateOnly(todayIn('Asia/Kolkata'))!;
const day = (offset: number) => formatDateOnly(addDays(today(), offset))!;
const iso = (d: Date) => formatDateOnly(d)!;
/** Days left counting today, as the API reports for active memberships. */
const left = (end: Date) => daysBetween(today(), end) + 1;
// The seed's memberships, worked out the same way the seed does (periodEnd is unit-tested).
const arjunEnd = () => periodEnd(addDays(today(), -25), 1);
const priyaEnd = () => periodEnd(addDays(today(), -100), 3);

async function memberId(slug: string, phone: string) {
  return runInTenant(await gymId(slug), async () =>
    String((await Member.findOne({ phone }).lean())!._id),
  );
}
async function planId(slug: string, name: string) {
  return runInTenant(await gymId(slug), async () =>
    String((await Plan.findOne({ name, archivedAt: null }).lean())!._id),
  );
}

describeWithDb('memberships (real MongoDB)', () => {
  let owner: string;
  let desk: string;
  let monthly: string;

  beforeAll(async () => {
    await connectTestDb(`memberships_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
    monthly = await planId('powerhouse', 'Monthly');
  });

  const sell = (mid: string, body: object, token = desk, host = PH) =>
    call('post', host, `/members/${mid}/memberships`, token).send(body);
  const renew = (mid: string, body: object = {}, token = desk) =>
    call('post', PH, `/members/${mid}/memberships/renew`, token).send(body);

  // ---------------------------------------------------------------- selling
  it('front desk sells a plan: snapshot, GST split, dates inclusive, audited', async () => {
    const suresh = await memberId('powerhouse', SURESH);
    const res = await sell(suresh, { planId: monthly });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: 'new',
      status: 'active',
      startDate: day(0),
      endDate: iso(periodEnd(today(), 1)),
      daysLeft: left(periodEnd(today(), 1)),
      plan: {
        name: 'Monthly',
        duration: 'monthly',
        months: 1,
        pricePaise: 150000,
        taxMode: 'inclusive',
        gstRate: 18,
      },
      basePaise: 127119,
      gstPaise: 22881,
      totalPaise: 150000,
    });
    const log = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.findOne({ action: 'membership.create' }).lean(),
    );
    expect(log!.metadata).toMatchObject({ plan: 'Monthly', totalPaise: 150000, startDate: day(0) });

    // Changing the plan later doesn't touch what was sold.
    await call('patch', PH, `/plans/${monthly}`, owner).send({ pricePaise: 180000 });
    const hist = await call('get', PH, `/members/${suresh}/memberships`, desk);
    expect(hist.body.data.items[0].totalPaise).toBe(150000);
  });

  it('discounts come off before GST; a discount above the price is refused', async () => {
    const suresh = await memberId('powerhouse', SURESH);
    const res = await sell(suresh, { planId: monthly, discountPaise: 50000 });
    expect(res.body.data).toMatchObject({
      discountPaise: 50000,
      basePaise: 84746,
      gstPaise: 15254,
      totalPaise: 100000,
    });
    const vikram = await memberId('powerhouse', VIKRAM);
    expect(
      (await sell(vikram, { planId: monthly, discountPaise: 150001, startDate: day(400) })).status,
    ).toBe(422);
  });

  it('refuses overlapping memberships and says when the next one can start', async () => {
    const arjun = await memberId('powerhouse', ARJUN);
    const res = await sell(arjun, { planId: monthly });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({
      endDate: iso(arjunEnd()),
      availableFrom: iso(addDays(arjunEnd(), 1)),
    });
    expect(
      (await sell(arjun, { planId: monthly, startDate: iso(addDays(arjunEnd(), 1)) })).status,
    ).toBe(201);
  });

  it('parallel sales for one member: exactly one wins', async () => {
    const suresh = await memberId('powerhouse', SURESH);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => sell(suresh, { planId: monthly })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect(
      await runInTenant(await gymId('powerhouse'), () =>
        Membership.countDocuments({ memberId: suresh }),
      ),
    ).toBe(1);
  });

  it('422 for bad dates and ids; 409 for archived plans and archived members', async () => {
    const suresh = await memberId('powerhouse', SURESH);
    for (const body of [
      { planId: monthly, startDate: day(-400) },
      { planId: monthly, startDate: day(120) },
      { planId: monthly, startDate: '15/01/2026' },
      { planId: 'nope' },
      { planId: monthly, discountPaise: 10.5 },
    ]) {
      expect((await sell(suresh, body)).status, JSON.stringify(body)).toBe(422);
    }
    await call('post', PH, `/plans/${monthly}/archive`, owner);
    expect((await sell(suresh, { planId: monthly })).status).toBe(409);
    const annual = await planId('powerhouse', 'Annual');
    await call('post', PH, `/members/${suresh}/archive`, owner);
    expect((await sell(suresh, { planId: annual })).status).toBe(409);
  });

  // ---------------------------------------------------------------- renewing
  it('renewing an active member starts the day after expiry, with the same plan by default', async () => {
    const arjun = await memberId('powerhouse', ARJUN);
    const res = await renew(arjun);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: 'renewal',
      status: 'upcoming',
      startDate: iso(addDays(arjunEnd(), 1)),
      endDate: iso(periodEnd(addDays(arjunEnd(), 1), 1)),
      daysLeft: left(arjunEnd()),
      plan: { name: 'Monthly' },
    });
    expect(res.body.data.previousMembershipId).toBeTruthy();

    const detail = await call('get', PH, `/members/${arjun}`, desk);
    expect(detail.body.data.membership).toMatchObject({
      status: 'active',
      nextStartDate: iso(addDays(arjunEnd(), 1)),
    });
    expect(detail.body.data.membership.current.endDate).toBe(iso(arjunEnd()));
  });

  it('renewing a lapsed member starts today by default, or back-dated from expiry if asked', async () => {
    const priya = await memberId('powerhouse', PRIYA);
    const quarterly = await planId('powerhouse', 'Quarterly');
    const fromToday = await renew(priya);
    expect(fromToday.body.data).toMatchObject({ startDate: day(0), status: 'active' });

    await call('post', PH, `/memberships/${fromToday.body.data.id}/cancel`, desk).send({
      reason: 'redo',
    });
    const fromExpiry = await renew(priya, { startFrom: 'expiry', planId: quarterly });
    // Starts the day after the old one ended (in the past): the lapse isn't free.
    expect(fromExpiry.body.data).toMatchObject({
      startDate: iso(addDays(priyaEnd(), 1)),
      endDate: iso(periodEnd(addDays(priyaEnd(), 1), 3)),
      daysLeft: left(periodEnd(addDays(priyaEnd(), 1), 3)),
    });
  });

  it("'today' is refused while a membership is running; no history needs a plan", async () => {
    const vikram = await memberId('powerhouse', VIKRAM);
    expect((await renew(vikram, { startFrom: 'today' })).status).toBe(409);
    const suresh = await memberId('powerhouse', SURESH);
    expect((await renew(suresh)).status).toBe(422);
    expect((await renew(suresh, { startFrom: 'expiry', planId: monthly })).status).toBe(409);
    const first = await renew(suresh, { planId: monthly });
    expect(first.body.data).toMatchObject({ kind: 'new', startDate: day(0) });
  });

  // ---------------------------------------------------------------- cancelling
  it('cancels active or upcoming memberships with a reason; not expired or twice', async () => {
    const arjun = await memberId('powerhouse', ARJUN);
    const hist = await call('get', PH, `/members/${arjun}/memberships`, desk);
    const id = hist.body.data.items[0].id;
    expect((await call('post', PH, `/memberships/${id}/cancel`, desk).send({})).status).toBe(422);
    const res = await call('post', PH, `/memberships/${id}/cancel`, desk).send({
      reason: 'Moved city',
    });
    expect(res.body.data).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Moved city',
      daysLeft: null,
    });
    expect(
      (await call('post', PH, `/memberships/${id}/cancel`, desk).send({ reason: 'again' })).status,
    ).toBe(409);
    // Freed days can be sold again.
    expect((await sell(arjun, { planId: monthly })).status).toBe(201);

    const priya = await memberId('powerhouse', PRIYA);
    const expired = (await call('get', PH, `/members/${priya}/memberships`, desk)).body.data
      .items[0];
    expect(expired.status).toBe('expired');
    expect(
      (await call('post', PH, `/memberships/${expired.id}/cancel`, desk).send({ reason: 'late' }))
        .status,
    ).toBe(409);
  });

  // ---------------------------------------------------------------- lists
  it('gym-wide list filters by derived status', async () => {
    const count = async (status: string) =>
      (await call('get', PH, `/memberships?status=${status}`, desk)).body.meta.total;
    expect(await count('active')).toBe(2);
    expect(await count('expired')).toBe(1);
    expect(await count('upcoming')).toBe(0);
    await renew(await memberId('powerhouse', ARJUN));
    expect(await count('upcoming')).toBe(1);
    const rows = (await call('get', PH, '/memberships?status=expired', desk)).body.data;
    expect(rows[0].member).toMatchObject({ name: 'Priya Nair', memberCode: 'M0002' });
    expect((await call('get', PH, '/memberships?status=paused', desk)).status).toBe(422);
  });

  it('expiring soon: within the gym reminder window, excluding renewed and archived members', async () => {
    const exp = await call('get', PH, '/memberships/expiring', desk);
    expect(exp.status).toBe(200);
    expect(exp.body.meta).toMatchObject({ days: 7, until: day(7), total: 1 });
    expect(exp.body.data[0]).toMatchObject({
      endDate: iso(arjunEnd()),
      daysLeft: left(arjunEnd()),
      member: { name: 'Arjun Sharma' },
    });
    expect(
      (
        await call(
          'get',
          PH,
          `/memberships/expiring?days=${daysBetween(today(), arjunEnd()) - 1}`,
          desk,
        )
      ).body.meta.total,
    ).toBe(0);
    expect((await call('get', PH, '/memberships/expiring?days=90', desk)).body.meta.total).toBe(1);

    const arjun = await memberId('powerhouse', ARJUN);
    await renew(arjun);
    expect((await call('get', PH, '/memberships/expiring', desk)).body.meta.total).toBe(0);

    // A cancelled renewal puts them back on the list; archiving takes them off.
    const upcoming = (await call('get', PH, '/memberships?status=upcoming', desk)).body.data[0];
    await call('post', PH, `/memberships/${upcoming.id}/cancel`, desk).send({ reason: 'mistake' });
    expect((await call('get', PH, '/memberships/expiring', desk)).body.meta.total).toBe(1);
    await call('post', PH, `/members/${arjun}/archive`, owner);
    expect((await call('get', PH, '/memberships/expiring', desk)).body.meta.total).toBe(0);
  });

  // ---------------------------------------------------------------- member app
  it("a member sees their own memberships (no staff notes), and nobody else's", async () => {
    const arjun = await memberId('powerhouse', ARJUN);
    await renew(arjun, { notes: 'Paid via UPI, owner approved' });
    const me = await memberToken(PH, 'arjun@member.demo');
    const res = await call('get', PH, '/members/me/memberships', me);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({
      status: 'active',
      nextStartDate: iso(addDays(arjunEnd(), 1)),
    });
    expect(res.body.data.items).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toContain('owner approved');
    expect(res.body.data.items[0]).not.toHaveProperty('soldBy');

    const priya = await memberId('powerhouse', PRIYA);
    expect((await call('get', PH, `/members/${priya}/memberships`, me)).status).toBe(403);
    expect((await call('get', PH, `/members/${arjun}/memberships`, me)).status).toBe(403);
    expect((await call('get', PH, '/memberships', me)).status).toBe(403);
    expect((await sell(arjun, { planId: monthly, startDate: day(40) }, me)).status).toBe(403);
    expect((await call('get', PH, '/members/me/memberships', desk)).status).toBe(403);
    expect((await call('get', PH, '/memberships')).status).toBe(401);
  });

  // ---------------------------------------------------------------- cross-tenant
  it("cross-tenant: FitZone can't read, sell, renew or cancel Powerhouse memberships", async () => {
    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    const phArjun = await memberId('powerhouse', ARJUN);
    const phMembership = (await call('get', PH, `/members/${phArjun}/memberships`, desk)).body.data
      .items[0].id;

    expect((await call('get', FZ, `/members/${phArjun}/memberships`, fzOwner)).status).toBe(404);
    expect(
      (await sell(phArjun, { planId: await planId('fitzone', 'Monthly') }, fzOwner, FZ)).status,
    ).toBe(404);
    expect(
      (await call('post', FZ, `/members/${phArjun}/memberships/renew`, fzOwner).send({})).status,
    ).toBe(404);
    expect(
      (
        await call('post', FZ, `/memberships/${phMembership}/cancel`, fzOwner).send({
          reason: 'evil',
        })
      ).status,
    ).toBe(404);
    // A Powerhouse plan id can't be sold to a FitZone member.
    const fzSuresh = await runInTenant(await gymId('fitzone'), async () =>
      String((await Member.findOne({ phone: '+919833333341' }).lean())!._id),
    );
    expect((await sell(fzSuresh, { planId: monthly }, fzOwner, FZ)).status).toBe(404);
    // FitZone's lists contain only FitZone rows.
    const fzActive = (await call('get', FZ, '/memberships?status=active', fzOwner)).body.data;
    expect(fzActive.map((m: { member: { name: string } }) => m.member.name)).toEqual([
      'Arjun Sharma',
    ]);
    expect((await call('get', FZ, '/memberships/expiring?days=30', fzOwner)).body.meta.total).toBe(
      0,
    );
    expect((await call('get', PH, '/memberships', fzOwner)).status).toBe(401);
    // Nothing changed on the Powerhouse side.
    expect(
      (await call('get', PH, `/members/${phArjun}/memberships`, desk)).body.data.items[0].status,
    ).toBe('active');
    expect(
      await runInTenant(await gymId('powerhouse'), () => User.countDocuments({ role: 'member' })),
    ).toBe(3);
  });
});
