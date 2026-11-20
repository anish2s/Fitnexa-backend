import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { addDays, formatDateOnly, parseDateOnly, todayIn } from '../../src/lib/dates.js';
import { Attendance } from '../../src/modules/attendance/attendance.model.js';
import { Member } from '../../src/modules/members/member.model.js';
import { Plan } from '../../src/modules/plans/plan.model.js';
import { Tenant } from '../../src/modules/tenants/tenant.model.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { PASSWORD, PH, PLATFORM, gymId, intApp, resetDemo } from '../helpers/int.js';

/**
 * Phase 3 member app backend: separate member/staff addresses (WRONG_SITE), the gym's public
 * contact, the member's monthly goal, plan descriptions and the visit-stats summary.
 */
const STAFF_PH = 'powerhouse.staff.localhost';
const split = intApp({
  STAFF_BASE_DOMAINS: 'staff.localhost',
  STAFF_APP_URL_TEMPLATE: 'http://{slug}.staff.localhost:3001',
  GYM_APP_URL_TEMPLATE: 'http://{slug}.localhost:3005',
});
const plain = intApp();
/** The owner's layout (2026-11-20): members on <gym>-pwa.<domain>, staff on <gym>.<domain>. */
const suffixed = intApp({
  MEMBER_HOST_SUFFIX: '-pwa',
  STAFF_APP_URL_TEMPLATE: 'http://{slug}.localhost:3001',
  GYM_APP_URL_TEMPLATE: 'http://{slug}-pwa.localhost:3005',
});
const MEMBER_PH = 'powerhouse-pwa.localhost';

/** The refresh cookie from a session response. */
const cookieOf = (res: request.Response) =>
  ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((c) => c.startsWith('gym_rt='))!
    .split(';')[0]!;

describeWithDb('member app backend (real MongoDB)', () => {
  let ph: string;

  beforeAll(async () => {
    await connectTestDb(`member_app_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(split.mailer);
    plain.mailer.clear();
    ph = await gymId('powerhouse');
  });

  it("owner's layout: <gym>-pwa is the member app, <gym> the staff dashboard; names ending -pwa are reserved", async () => {
    suffixed.mailer.clear();
    expect((await suffixed.call('get', MEMBER_PH, '/public/tenant')).body.data).toMatchObject({
      slug: 'powerhouse',
      site: 'member',
    });
    expect((await suffixed.call('get', PH, '/public/tenant')).body.data.site).toBe('staff');

    // Staff sign in on the main address only; members by email link on the -pwa address only.
    expect(
      (
        await suffixed
          .call('post', MEMBER_PH, '/auth/login')
          .send({ identifier: 'owner@powerhouse.demo', password: PASSWORD })
      ).body.error.code,
    ).toBe('WRONG_SITE');
    expect(
      (await suffixed.call('post', PH, '/auth/magic-link').send({ email: 'priya@member.demo' }))
        .body.error.code,
    ).toBe('WRONG_SITE');
    const member = await suffixed.memberToken(MEMBER_PH, 'priya@member.demo');
    expect((await suffixed.call('get', MEMBER_PH, '/members/me', member)).status).toBe(200);
    expect((await suffixed.call('get', PH, '/members/me', member)).body.error.code).toBe(
      'WRONG_SITE',
    );
    // The sign-in email links to the -pwa address.
    expect(suffixed.mailer.outbox.at(-1)?.text).toContain(
      'http://powerhouse-pwa.localhost:3005/login/verify?token=',
    );

    // A gym can't be created as "<name>-pwa" (it would clash with <name>'s member address).
    const admin = await suffixed.tokenFor(PLATFORM, 'admin@platform.demo');
    const check = async (slug: string) =>
      (
        await suffixed.call(
          'get',
          PLATFORM,
          `/platform/tenants/slug-availability?slug=${slug}`,
          admin,
        )
      ).body.data;
    expect(await check('newgym-pwa')).toMatchObject({ available: false, reason: 'reserved' });
    expect(await check('newgym')).toMatchObject({ available: true });
  });

  it('public branding says which site the address is, and carries only the business contact', async () => {
    expect((await plain.call('get', PH, '/public/tenant')).body.data.site).toBe('any');
    expect((await split.call('get', PH, '/public/tenant')).body.data.site).toBe('member');
    const staff = (await split.call('get', STAFF_PH, '/public/tenant')).body.data;
    expect(staff).toMatchObject({ slug: 'powerhouse', site: 'staff' });
    expect(staff.contact).toEqual({ phone: '+919800000001', address: null, city: 'Pune' });

    await Tenant.updateOne(
      { _id: ph },
      { $set: { 'address.line1': '2nd floor, MG Road', 'address.line2': ' Camp ' } },
    );
    const pub = (await plain.call('get', PH, '/public/tenant')).body.data;
    expect(pub.contact).toEqual({
      phone: '+919800000001',
      address: '2nd floor, MG Road, Camp',
      city: 'Pune',
    });
    expect(Object.keys(pub).sort()).toEqual([
      'branding',
      'contact',
      'name',
      'site',
      'slug',
      'status',
    ]);
  });

  it('member site: email-link sign-in only; staff site: password sign-in only (403 WRONG_SITE)', async () => {
    const owner = { identifier: 'owner@powerhouse.demo', password: 'demo-Password-123' };
    const onMember = await split.call('post', PH, '/auth/login').send(owner);
    expect(onMember.status).toBe(403);
    expect(onMember.body.error).toMatchObject({
      code: 'WRONG_SITE',
      message: 'Staff sign in on the staff dashboard.',
    });
    expect((await split.call('post', STAFF_PH, '/auth/login').send(owner)).status).toBe(200);

    const link = await split
      .call('post', STAFF_PH, '/auth/magic-link')
      .send({ email: 'priya@member.demo' });
    expect(link.status).toBe(403);
    expect(link.body.error).toMatchObject({
      code: 'WRONG_SITE',
      message: "Members sign in on the gym's member app.",
    });
    expect(
      (
        await split
          .call('post', STAFF_PH, '/auth/magic-link/verify')
          .send({ token: 'x'.repeat(43) })
      ).body.error.code,
    ).toBe('WRONG_SITE');
    expect(
      (
        await split
          .call('post', PH, '/auth/password/forgot')
          .send({ email: 'owner@powerhouse.demo' })
      ).body.error.code,
    ).toBe('WRONG_SITE');
    expect(
      (
        await split
          .call('post', PH, '/auth/password/reset')
          .send({ token: 'x'.repeat(43), password: 'another-Password-1' })
      ).body.error.code,
    ).toBe('WRONG_SITE');

    // Member sign-in works on the member site; the link points at the member app.
    expect(
      (await split.call('post', PH, '/auth/magic-link').send({ email: 'priya@member.demo' }))
        .status,
    ).toBe(202);
    expect(split.mailer.outbox.at(-1)!.text).toContain(
      'http://powerhouse.localhost:3005/login/verify?token=',
    );

    // Staff password emails point at the staff dashboard.
    expect(
      (
        await split
          .call('post', STAFF_PH, '/auth/password/forgot')
          .send({ email: 'owner@powerhouse.demo' })
      ).status,
    ).toBe(202);
    expect(split.mailer.outbox.at(-1)!.text).toContain(
      'http://powerhouse.staff.localhost:3001/reset-password?token=',
    );

    // Without a staff address everything stays on the one address (as before).
    expect((await plain.call('post', PH, '/auth/login').send(owner)).status).toBe(200);
    expect(
      (await plain.call('post', PH, '/auth/magic-link').send({ email: 'priya@member.demo' }))
        .status,
    ).toBe(202);
  });

  it('a session only works on its own site: tokens, refresh and the session lookup', async () => {
    const ownerToken = await split.tokenFor(STAFF_PH, 'owner@powerhouse.demo');
    const memberToken = await split.memberToken(PH, 'priya@member.demo');

    expect((await split.call('get', PH, '/auth/me', ownerToken)).body.error.code).toBe(
      'WRONG_SITE',
    );
    expect((await split.call('get', STAFF_PH, '/members/me', memberToken)).body.error.code).toBe(
      'WRONG_SITE',
    );
    expect((await split.call('get', STAFF_PH, '/auth/me', ownerToken)).status).toBe(200);
    expect((await split.call('get', PH, '/members/me', memberToken)).status).toBe(200);

    const login = await split
      .call('post', STAFF_PH, '/auth/login')
      .send({ identifier: 'owner@powerhouse.demo', password: 'demo-Password-123' });
    const cookie = cookieOf(login);
    const cross = await request(split.app)
      .post('/api/v1/auth/refresh')
      .set('Host', PH)
      .set('Origin', 'http://powerhouse.localhost:3005')
      .set('Cookie', cookie);
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('WRONG_SITE');
    expect(
      (await request(split.app).get('/api/v1/auth/session').set('Host', PH).set('Cookie', cookie))
        .body.error.code,
    ).toBe('WRONG_SITE');
    // The session wasn't rotated by the refused attempt: it still refreshes on its own site.
    const own = await request(split.app)
      .post('/api/v1/auth/refresh')
      .set('Host', STAFF_PH)
      .set('Origin', 'http://powerhouse.staff.localhost:3001')
      .set('Cookie', cookie);
    expect(own.status).toBe(200);
  });

  it('the member sets their own monthly goal; staff see it but cannot set it', async () => {
    const member = await plain.memberToken(PH, 'priya@member.demo');
    const owner = await plain.tokenFor(PH, 'owner@powerhouse.demo');
    expect(
      (await plain.call('get', PH, '/members/me', member)).body.data.monthlyVisitGoal,
    ).toBeNull();

    const set = await plain.call('patch', PH, '/members/me', member).send({ monthlyVisitGoal: 20 });
    expect(set.status).toBe(200);
    expect(set.body.data.monthlyVisitGoal).toBe(20);
    for (const bad of [0, 32, 2.5, '20']) {
      expect(
        (await plain.call('patch', PH, '/members/me', member).send({ monthlyVisitGoal: bad }))
          .status,
        String(bad),
      ).toBe(422);
    }

    const id = String(
      (await runInTenant(ph, () => Member.findOne({ email: 'priya@member.demo' }).lean()))!._id,
    );
    expect((await plain.call('get', PH, `/members/${id}`, owner)).body.data.monthlyVisitGoal).toBe(
      20,
    );
    expect(
      (await plain.call('patch', PH, `/members/${id}`, owner).send({ monthlyVisitGoal: 5 })).status,
    ).toBe(422);
    await plain
      .call('patch', PH, `/members/${id}`, owner)
      .send({ name: 'Priya S', monthlyVisitGoal: 5 });
    expect((await plain.call('get', PH, '/members/me', member)).body.data.monthlyVisitGoal).toBe(
      20,
    );

    expect(
      (await plain.call('patch', PH, '/members/me', member).send({ monthlyVisitGoal: null })).body
        .data.monthlyVisitGoal,
    ).toBeNull();
  });

  it("each of the member's plans carries the plan's description (null when it has none)", async () => {
    const member = await plain.memberToken(PH, 'priya@member.demo');
    const before = (await plain.call('get', PH, '/members/me/memberships', member)).body.data;
    expect(before.items.length).toBeGreaterThan(0);
    expect(
      before.items.every((m: { plan: { description: unknown } }) => m.plan.description === null),
    ).toBe(true);

    const planId = before.items[0].plan.id as string;
    await runInTenant(ph, () =>
      Plan.updateOne({ _id: planId }, { $set: { description: 'Gym floor\nGroup classes' } }),
    );
    const after = (await plain.call('get', PH, '/members/me/memberships', member)).body.data;
    expect(after.items[0].plan.description).toBe('Gym floor\nGroup classes');
    if (after.summary.current?.plan.id === planId)
      expect(after.summary.current.plan.description).toBe('Gym floor\nGroup classes');
  });

  it('visit stats: streak, month, week, badges and goal in the gym time zone', async () => {
    const member = await plain.memberToken(PH, 'priya@member.demo');
    const owner = await plain.tokenFor(PH, 'owner@powerhouse.demo');
    const today = todayIn('Asia/Kolkata');
    const t = parseDateOnly(today)!;
    const day = (n: number) => formatDateOnly(addDays(t, n))!;
    const m = (await runInTenant(ph, () => Member.findOne({ email: 'priya@member.demo' }).lean()))!;
    // Yesterday and the two days before (current streak 3, today not yet), and an older run of 4.
    const days = [day(-1), day(-2), day(-3), day(-20), day(-21), day(-22), day(-23)];
    await runInTenant(ph, () =>
      Attendance.insertMany(
        days.map((d) => ({
          memberId: m._id,
          membershipId: m._id,
          day: d,
          hour: 7,
          checkedInAt: new Date(`${d}T01:30:00Z`),
          method: 'qr',
        })),
      ),
    );
    await plain.call('patch', PH, '/members/me', member).send({ monthlyVisitGoal: 16 });

    const res = await plain.call('get', PH, '/members/me/stats', member);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const s = res.body.data;
    expect(s).toMatchObject({
      today,
      lifetimeVisits: 7,
      checkedInToday: false,
      currentStreak: 3,
      bestStreak: 4,
      monthlyVisitGoal: 16,
    });
    expect(s.thisMonth).toBe(days.filter((d) => d.slice(0, 7) === today.slice(0, 7)).length);
    expect(s.week).toHaveLength(7);
    expect(s.thisWeek).toBe(s.week.filter(Boolean).length);
    expect(s.badges).toEqual([
      { visits: 1, earnedOn: day(-23) },
      { visits: 10, earnedOn: null },
      { visits: 25, earnedOn: null },
      { visits: 50, earnedOn: null },
      { visits: 100, earnedOn: null },
    ]);

    // Staff and the platform can't read a member's own stats.
    expect((await plain.call('get', PH, '/members/me/stats', owner)).status).toBe(403);
    expect((await plain.call('get', PLATFORM, '/members/me/stats')).status).toBeGreaterThanOrEqual(
      400,
    );
  });
});
