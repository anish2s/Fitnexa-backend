import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog, Plan, User } from '../../src/db/models.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

const { mailer, call, tokenFor, memberToken } = intApp();

async function planId(slug: string, name: string) {
  return runInTenant(await gymId(slug), async () =>
    String((await Plan.findOne({ name, archivedAt: null }).lean())!._id),
  );
}

describeWithDb('plans (real MongoDB)', () => {
  let owner: string;
  let desk: string;
  let fzOwner: string;

  beforeAll(async () => {
    await connectTestDb(`plans_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
    fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
  });

  it('lists live plans by duration with the GST breakdown; staff can read', async () => {
    const res = await call('get', PH, '/plans', desk);
    expect(res.status).toBe(200);
    expect(
      res.body.data.map((p: { name: string; duration: string; months: number }) => [
        p.name,
        p.duration,
        p.months,
      ]),
    ).toEqual([
      ['Monthly', 'monthly', 1],
      ['Quarterly', 'quarterly', 3],
      ['Half-yearly', 'half_yearly', 6],
      ['Annual', 'yearly', 12],
    ]);
    expect(res.body.data[0]).toMatchObject({
      duration: 'monthly',
      months: 1,
      pricePaise: 150000,
      taxMode: 'inclusive',
      gstRate: 18,
      breakdown: { basePaise: 127119, gstPaise: 22881, totalPaise: 150000 },
    });
    const fz = await call('get', FZ, '/plans', fzOwner);
    expect(fz.body.data[0]).toMatchObject({ taxMode: 'none', breakdown: { gstPaise: 0 } });
  });

  it('owner creates a plan: defaults to GST inclusive at 18% with a GSTIN, no GST without', async () => {
    const ph = await call('post', PH, '/plans', owner).send({
      name: 'Student Monthly',
      duration: 'monthly',
      pricePaise: 99900,
    });
    expect(ph.status).toBe(201);
    expect(ph.body.data).toMatchObject({ taxMode: 'inclusive', gstRate: 18 });

    const fz = await call('post', FZ, '/plans', fzOwner).send({
      name: 'Student Monthly',
      duration: 'monthly',
      pricePaise: 99900,
    });
    expect(fz.body.data).toMatchObject({ taxMode: 'none', gstRate: 0 });

    const ex = await call('post', PH, '/plans', owner).send({
      name: 'PT 10 sessions',
      duration: 'quarterly',
      pricePaise: 500000,
      taxMode: 'exclusive',
      gstRate: 18,
    });
    expect(ex.body.data.breakdown).toEqual({
      basePaise: 500000,
      gstPaise: 90000,
      totalPaise: 590000,
    });
    expect(
      await runInTenant(await gymId('powerhouse'), () =>
        AuditLog.countDocuments({ action: 'plan.create' }),
      ),
    ).toBe(2);
  });

  it('a gym without a GSTIN cannot charge GST', async () => {
    const res = await call('post', FZ, '/plans', fzOwner).send({
      name: 'Taxed',
      duration: 'monthly',
      pricePaise: 100000,
      taxMode: 'inclusive',
      gstRate: 18,
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/GSTIN/);
  });

  it('422 for bad input: fractional paise, 0 days, unknown GST rate, GST mode with 0%', async () => {
    for (const body of [
      { name: 'X', duration: 'monthly', pricePaise: 999.5 },
      { name: 'X', duration: 'weekly', pricePaise: 1000 },
      { name: 'X', duration: 'monthly', pricePaise: 1000, gstRate: 15 },
      { name: 'X', duration: 'monthly', pricePaise: 1000, taxMode: 'exclusive', gstRate: 0 },
      { name: '', duration: 'monthly', pricePaise: 1000 },
      { name: 'X', duration: 'monthly', pricePaise: -1 },
    ]) {
      expect(
        (await call('post', PH, '/plans', owner).send(body)).status,
        JSON.stringify(body),
      ).toBe(422);
    }
  });

  it('live plan names are unique per gym (case-insensitive); archived names can be reused', async () => {
    const dup = await call('post', PH, '/plans', owner).send({
      name: 'monthly',
      duration: 'monthly',
      pricePaise: 1,
    });
    expect(dup.status).toBe(409);
    const id = await planId('powerhouse', 'Monthly');
    expect((await call('post', PH, `/plans/${id}/archive`, owner)).status).toBe(200);
    const again = await call('post', PH, '/plans', owner).send({
      name: 'Monthly',
      duration: 'monthly',
      pricePaise: 160000,
    });
    expect(again.status).toBe(201);
    // Restoring the old one would now clash.
    expect((await call('post', PH, `/plans/${id}/restore`, owner)).status).toBe(409);
  });

  it('updates price and tax; changes are audited; archived plans are hidden and frozen', async () => {
    const id = await planId('powerhouse', 'Quarterly');
    const res = await call('patch', PH, `/plans/${id}`, owner).send({
      pricePaise: 420000,
      taxMode: 'exclusive',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ pricePaise: 420000, taxMode: 'exclusive', gstRate: 18 });
    const log = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.findOne({ action: 'plan.update' }).lean(),
    );
    expect(log!.changes).toEqual(
      expect.arrayContaining([
        { field: 'pricePaise', from: 400000, to: 420000 },
        { field: 'taxMode', from: 'inclusive', to: 'exclusive' },
      ]),
    );

    await call('post', PH, `/plans/${id}/archive`, owner);
    expect((await call('get', PH, '/plans', owner)).body.data).toHaveLength(3);
    expect((await call('get', PH, '/plans?archived=true', owner)).body.data[0].name).toBe(
      'Quarterly',
    );
    expect((await call('patch', PH, `/plans/${id}`, owner).send({ pricePaise: 1 })).status).toBe(
      409,
    );
    expect((await call('patch', PH, `/plans/${id}`, owner).send({})).status).toBe(422);
  });

  it('authorization: staff read only (unless granted plans:manage); members and anonymous refused', async () => {
    const body = { name: 'Desk Plan', duration: 'monthly', pricePaise: 1000 };
    expect((await call('post', PH, '/plans', desk).send(body)).status).toBe(403);
    const deskId = await runInTenant(await gymId('powerhouse'), async () =>
      String((await User.findOne({ email: 'desk@powerhouse.demo' }).lean())!._id),
    );
    await call('patch', PH, `/staff/${deskId}`, owner).send({ permissions: ['plans:manage'] });
    expect((await call('post', PH, '/plans', desk).send(body)).status).toBe(201);

    const member = await memberToken(PH, 'arjun@member.demo');
    expect((await call('get', PH, '/plans', member)).status).toBe(403);
    expect((await call('get', PH, '/plans')).status).toBe(401);
  });

  it("cross-tenant: FitZone can't read, edit or archive Powerhouse plans", async () => {
    const id = await planId('powerhouse', 'Monthly');
    expect((await call('get', FZ, `/plans/${id}`, fzOwner)).status).toBe(404);
    expect((await call('patch', FZ, `/plans/${id}`, fzOwner).send({ pricePaise: 1 })).status).toBe(
      404,
    );
    expect((await call('post', FZ, `/plans/${id}/archive`, fzOwner)).status).toBe(404);
    expect((await call('get', PH, '/plans', fzOwner)).status).toBe(401);
    expect((await call('get', PH, `/plans/${id}`, owner)).body.data.pricePaise).toBe(150000);
  });
});
