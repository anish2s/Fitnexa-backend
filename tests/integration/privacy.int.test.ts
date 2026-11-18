import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  Attendance,
  AuditLog,
  AuthToken,
  Member,
  Membership,
  Notification,
  Payment,
  Session,
  User,
} from '../../src/db/models.js';
import { cloudinaryImageStore } from '../../src/lib/image-store.js';
import { createLogger } from '../../src/lib/logger.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, PLATFORM, gymId, intApp, resetDemo } from '../helpers/int.js';

const cloudinary = vi.fn(async () => new Response(JSON.stringify({ result: 'ok' })));
const images = cloudinaryImageStore({
  cloudName: 'demo-cloud',
  apiKey: '123456789012',
  apiSecret: 'test-secret-value',
  folder: 'fitexaa-test',
  logger: createLogger('silent'),
  fetch: cloudinary as unknown as typeof fetch,
});
const { mailer, call, tokenFor, memberToken } = intApp({}, images);

const ARJUN = '+919811111111';
async function inPH<T>(fn: () => Promise<T>) {
  return runInTenant(await gymId('powerhouse'), fn);
}
async function member(phone: string) {
  return inPH(async () => (await Member.findOne({ phone }).lean())!);
}

describeWithDb('DPDP export and erasure (real MongoDB)', () => {
  let owner: string;
  let desk: string;
  beforeAll(async () => {
    await connectTestDb(`privacy_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    cloudinary.mockClear();
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
  });

  // ---------------------------------------------------------------- export
  it('owner exports everything held about a member as a JSON download', async () => {
    const a = await member(ARJUN);
    await call('patch', PH, `/members/${a._id}`, desk).send({ notes: 'Prefers mornings' });
    const res = await call('get', PH, `/members/${a._id}/export`, owner);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="member-M0001-data.json"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const d = res.body.data;
    expect(d.member).toMatchObject({
      memberCode: 'M0001',
      name: 'Arjun Sharma',
      phone: ARJUN,
      email: 'arjun@member.demo',
      notes: 'Prefers mornings',
      consent: { version: 'v1' },
    });
    expect(d.login).toMatchObject({ email: 'arjun@member.demo', status: 'active' });
    expect(JSON.stringify(d)).not.toMatch(/passwordHash|tokenHash|refreshTokenHash/);
    expect(d.memberships).toHaveLength(1);
    expect(d.payments[0]).toMatchObject({ amountPaise: 50000, method: 'cash' });
    expect(d.attendance).toHaveLength(1);
    expect(d.gym).toBe('Powerhouse Fitness');
    const log = await inPH(() => AuditLog.findOne({ action: 'member.export' }).lean());
    expect(log!.target).toMatchObject({ type: 'member', id: String(a._id) });
  });

  it('a member downloads their own data, without staff-internal notes', async () => {
    const a = await member(ARJUN);
    await call('patch', PH, `/members/${a._id}`, desk).send({ notes: 'Difficult about payments' });
    const me = await memberToken(PH, 'arjun@member.demo');
    const res = await call('get', PH, '/members/me/export', me);
    expect(res.status).toBe(200);
    expect(res.body.data.member).toMatchObject({ memberCode: 'M0001', phone: ARJUN });
    expect(JSON.stringify(res.body)).not.toContain('Difficult');
    expect(res.body.data.memberships[0]).not.toHaveProperty('soldBy');
    expect(res.body.data.payments[0]).not.toHaveProperty('receivedBy');
    expect((await call('get', PH, `/members/${a._id}/export`, me)).status).toBe(403);
  });

  // ---------------------------------------------------------------- erase
  it('erasure removes personal data, keeps anonymised records, and ends the login', async () => {
    const a = await member(ARJUN);
    const me = await memberToken(PH, 'arjun@member.demo');
    await inPH(() =>
      Member.updateOne(
        { _id: a._id },
        {
          photoPublicId: `fitexaa-test/gyms/x/members/${a._id}/abc`,
          photoUrl: 'https://res.cloudinary.com/x.jpg',
          notes: 'Knee injury',
          dateOfBirth: new Date('1990-01-01'),
        },
      ),
    );
    await inPH(() => Payment.updateMany({ memberId: a._id }, { notes: 'Paid by brother Ravi' }));
    await inPH(() =>
      Notification.create({
        memberId: a._id,
        membershipId: a._id,
        kind: 'renewal_expiring',
        dedupeKey: `x:${a._id}`,
        nextAttemptAt: new Date(),
      }),
    );

    expect(
      (
        await call('post', PH, `/members/${a._id}/erase`, owner).send({
          confirmMemberCode: 'M0002',
          reason: 'Member asked by email',
        })
      ).status,
    ).toBe(422);
    const res = await call('post', PH, `/members/${a._id}/erase`, owner).send({
      confirmMemberCode: 'm0001',
      reason: 'Member asked by email',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ memberCode: 'M0001' });
    expect(res.body.data.removed).toContain('phone');
    expect(res.body.data.retained.join(' ')).toMatch(/tax/);

    const after = await inPH(() => Member.findById(a._id).lean());
    expect(after).toMatchObject({ name: 'Erased member M0001', memberCode: 'M0001' });
    for (const f of [
      'phone',
      'email',
      'notes',
      'dateOfBirth',
      'photoUrl',
      'photoPublicId',
      'userId',
      'emergencyContact',
    ]) {
      expect(after, f).not.toHaveProperty(f);
    }
    expect(after!.archivedAt).toBeTruthy();
    expect(cloudinary).toHaveBeenCalledOnce();

    // Login, sessions and links are gone; the old token stops working at once.
    expect(await inPH(() => User.countDocuments({ memberId: a._id }))).toBe(0);
    expect(await inPH(() => Session.countDocuments({ userId: a.userId }))).toBe(0);
    expect(await inPH(() => AuthToken.countDocuments({ userId: a.userId }))).toBe(0);
    expect((await call('get', PH, '/members/me', me)).status).toBe(401);
    expect(await inPH(() => Notification.countDocuments({ memberId: a._id }))).toBe(0);

    // Financial and attendance records stay, without personal notes; receipts still print.
    const pays = await inPH(() => Payment.find({ memberId: a._id }).lean());
    expect(pays).toHaveLength(1);
    expect(pays[0]).not.toHaveProperty('notes');
    expect(await inPH(() => Membership.countDocuments({ memberId: a._id }))).toBe(1);
    expect(await inPH(() => Attendance.countDocuments({ memberId: a._id }))).toBe(1);
    const pdf = await call('get', PH, `/payments/${pays[0]!._id}/receipt`, owner);
    expect(pdf.status).toBe(200);

    // The audit entry holds the code and reason, not the erased details.
    const log = await inPH(() => AuditLog.findOne({ action: 'member.erase' }).lean());
    expect(log!.metadata).toEqual({ memberCode: 'M0001', reason: 'Member asked by email' });
    expect(JSON.stringify(log)).not.toMatch(/Arjun|981111|arjun@/);
  });

  it('after erasure: no second erase, no restore, no edits; the phone can be used by someone new', async () => {
    const a = await member(ARJUN);
    const priya = await member('+919811111112');
    for (const m of [a, priya]) {
      expect(
        (
          await call('post', PH, `/members/${m._id}/erase`, owner).send({
            confirmMemberCode: m.memberCode,
            reason: 'Requested in person',
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await call('post', PH, `/members/${a._id}/erase`, owner).send({
          confirmMemberCode: 'M0001',
          reason: 'again please',
        })
      ).status,
    ).toBe(409);
    expect((await call('post', PH, `/members/${a._id}/restore`, owner)).status).toBe(409);
    expect((await call('patch', PH, `/members/${a._id}`, desk).send({ name: 'Back' })).status).toBe(
      409,
    );
    const reuse = await call('post', PH, '/members', desk).send({
      name: 'New Person',
      phone: ARJUN,
      email: 'arjun@member.demo',
      consent: true,
    });
    expect(reuse.status).toBe(201);
    expect(reuse.body.data.memberCode).toBe('M0005');
    const dash = (await call('get', PH, '/dashboard', owner)).body.data;
    expect(dash.members.total).toBe(3);
  });

  // ---------------------------------------------------------------- authorization
  it('only the owner may export or erase; never staff (not even granted), never while impersonated', async () => {
    const a = await member(ARJUN);
    expect((await call('get', PH, `/members/${a._id}/export`, desk)).status).toBe(403);
    expect(
      (
        await call('post', PH, `/members/${a._id}/erase`, desk).send({
          confirmMemberCode: 'M0001',
          reason: 'desk tries',
        })
      ).status,
    ).toBe(403);
    const deskId = await inPH(async () =>
      String((await User.findOne({ email: 'desk@powerhouse.demo' }).lean())!._id),
    );
    expect(
      (await call('patch', PH, `/staff/${deskId}`, owner).send({ permissions: ['privacy:manage'] }))
        .status,
    ).toBe(422);

    const admin = await tokenFor(PLATFORM, 'admin@platform.demo');
    const imp = await call(
      'post',
      PLATFORM,
      `/platform/tenants/${await gymId('powerhouse')}/impersonate`,
      admin,
    ).send({ reason: 'Support ticket 4521' });
    const res = await call('post', PH, `/members/${a._id}/erase`, imp.body.data.accessToken).send({
      confirmMemberCode: 'M0001',
      reason: 'admin tries',
    });
    expect(res.status).toBe(403);
    expect((await call('get', PH, '/members/me/export')).status).toBe(401);
  });

  // ---------------------------------------------------------------- cross-tenant
  it("cross-tenant: FitZone can't export or erase a Powerhouse member; the same person at FitZone is untouched", async () => {
    const a = await member(ARJUN);
    const fz = await tokenFor(FZ, 'owner@fitzone.demo');
    expect((await call('get', FZ, `/members/${a._id}/export`, fz)).status).toBe(404);
    expect(
      (
        await call('post', FZ, `/members/${a._id}/erase`, fz).send({
          confirmMemberCode: 'M0001',
          reason: 'cross gym',
        })
      ).status,
    ).toBe(404);

    await call('post', PH, `/members/${a._id}/erase`, owner).send({
      confirmMemberCode: 'M0001',
      reason: 'Requested in person',
    });
    const fzArjun = await runInTenant(await gymId('fitzone'), () =>
      Member.findOne({ phone: ARJUN }).lean(),
    );
    expect(fzArjun).toMatchObject({ name: 'Arjun Sharma', email: 'arjun@member.demo' });
    expect(await memberToken(FZ, 'arjun@member.demo')).toBeTruthy();
  });
});
