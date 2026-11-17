import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog, Member, User } from '../../src/db/models.js';
import { todayIn } from '../../src/lib/dates.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

const { mailer, call, tokenFor, memberToken } = intApp();

async function memberIdOf(slug: string, phone: string) {
  return runInTenant(await gymId(slug), async () =>
    String((await Member.findOne({ phone }).lean())!._id),
  );
}

const ARJUN = '+919811111111';
const PRIYA = '+919811111112';
const SURESH = '+919833333331'; // walk-in, no email

const newMember = {
  name: 'Neha Gupta',
  phone: '98444 55566',
  email: 'Neha@Member.demo',
  gender: 'female',
  dateOfBirth: '1995-06-20',
  emergencyContact: { name: 'Raj Gupta', phone: '9844455500', relation: 'Father' },
  notes: 'Knee injury 2025, avoid heavy squats',
  consent: true,
};

describeWithDb('member management (real MongoDB)', () => {
  let owner: string;
  let desk: string;

  beforeAll(async () => {
    await connectTestDb(`members_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
  });

  // ---------------------------------------------------------------- create
  it('front desk registers a member with email: next code, consent recorded, app access works', async () => {
    const res = await call('post', PH, '/members', desk).send(newMember);
    expect(res.status).toBe(201);
    const m = res.body.data;
    expect(m).toMatchObject({
      memberCode: 'M0005',
      name: 'Neha Gupta',
      phone: '+919844455566',
      email: 'neha@member.demo',
      dateOfBirth: '1995-06-20',
      joinDate: todayIn('Asia/Kolkata'),
      emergencyContact: { name: 'Raj Gupta', phone: '+919844455500', relation: 'Father' },
      appAccess: { enabled: true, reason: null },
      consent: { version: 'v1' },
    });

    // The new member signs in by email link and sees their own profile, minus staff notes.
    const neha = await memberToken(PH, 'neha@member.demo');
    const me = await call('get', PH, '/members/me', neha);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ memberCode: 'M0005', name: 'Neha Gupta' });
    expect(me.body.data).not.toHaveProperty('notes');
    expect(JSON.stringify(me.body)).not.toContain('Knee');

    const log = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.findOne({ action: 'member.create' }).lean(),
    );
    expect(log!.actor).toMatchObject({ role: 'staff' });
  });

  it('registers a walk-in without email: no login, app access off with a reason', async () => {
    const res = await call('post', PH, '/members', desk).send({
      name: 'Walk In',
      phone: '9844400000',
      consent: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.appAccess).toMatchObject({ enabled: false, reason: 'no_email' });
    expect(
      await runInTenant(await gymId('powerhouse'), () =>
        User.countDocuments({ memberId: res.body.data.id }),
      ),
    ).toBe(0);
  });

  it('parallel registrations get unique, consecutive member codes', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call('post', PH, '/members', desk).send({
          name: `Batch ${i}`,
          phone: `98555000${String(i).padStart(2, '0')}`,
          consent: true,
        }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const codes = results.map((r) => r.body.data.memberCode as string).sort();
    expect(codes).toEqual(['M0005', 'M0006', 'M0007', 'M0008', 'M0009', 'M0010', 'M0011', 'M0012']);
  });

  it('422: no consent, bad phone, future birth date, malformed or far-future join date', async () => {
    const bad = [
      { ...newMember, consent: undefined },
      { ...newMember, consent: false },
      { ...newMember, phone: '123' },
      { ...newMember, dateOfBirth: '2099-01-01' },
      { ...newMember, dateOfBirth: '1995-02-30' },
      { ...newMember, joinDate: '01/04/2026' },
      { ...newMember, joinDate: '2099-01-01' },
      { ...newMember, gender: 'robot' },
    ];
    for (const body of bad) {
      const res = await call('post', PH, '/members', desk).send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(await runInTenant(await gymId('powerhouse'), () => Member.countDocuments())).toBe(4);
  });

  it('409 for a phone or email already used in this gym; the same phone is fine in another gym', async () => {
    const phone = await call('post', PH, '/members', desk).send({ ...newMember, phone: ARJUN });
    expect(phone.status).toBe(409);
    expect(JSON.stringify(phone.body)).not.toContain('981111');
    const staffEmail = await call('post', PH, '/members', desk).send({
      ...newMember,
      email: 'desk@powerhouse.demo',
    });
    expect(staffEmail.status).toBe(409);
    // Nothing half-created: the transaction rolled back the member too.
    expect(await runInTenant(await gymId('powerhouse'), () => Member.countDocuments())).toBe(4);

    const fzDesk = await tokenFor(FZ, 'desk@fitzone.demo');
    const fz = await call('post', FZ, '/members', fzDesk).send({
      ...newMember,
      phone: PRIYA,
      email: 'priya@member.demo',
    });
    expect(fz.status).toBe(201);
  });

  // ---------------------------------------------------------------- list & search
  it('lists with search by name, phone digits, email and code; paginates; hides archived', async () => {
    const all = await call('get', PH, '/members', desk);
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(4);
    expect(all.headers['cache-control']).toBe('no-store');

    const q = async (s: string) =>
      (await call('get', PH, `/members?q=${encodeURIComponent(s)}`, desk)).body.data.map(
        (m: { name: string }) => m.name,
      );
    expect(await q('arjun')).toEqual(['Arjun Sharma']);
    expect(await q('98111 11112')).toEqual(['Priya Nair']);
    expect(await q('vikram@')).toEqual(['Vikram Singh']);
    expect(await q('m0004')).toEqual(['Suresh Kumar']);
    expect(await q('.*')).toEqual([]);

    const page = await call('get', PH, '/members?limit=3&page=2&sort=name', desk);
    expect(page.body.data.map((m: { name: string }) => m.name)).toEqual(['Vikram Singh']);
    expect((await call('get', PH, '/members?sort=evil', desk)).status).toBe(422);

    const id = await memberIdOf('powerhouse', PRIYA);
    await call('post', PH, `/members/${id}/archive`, owner);
    expect((await call('get', PH, '/members', desk)).body.meta.total).toBe(3);
    const archived = await call('get', PH, '/members?archived=true', desk);
    expect(archived.body.data.map((m: { name: string }) => m.name)).toEqual(['Priya Nair']);
  });

  // ---------------------------------------------------------------- update & login sync
  it('adding an email to a walk-in gives app access; removing it ends their sessions', async () => {
    const id = await memberIdOf('powerhouse', SURESH);
    const add = await call('patch', PH, `/members/${id}`, desk).send({
      email: 'suresh@member.demo',
    });
    expect(add.status).toBe(200);
    expect(add.body.data.appAccess.enabled).toBe(true);
    const suresh = await memberToken(PH, 'suresh@member.demo');
    expect((await call('get', PH, '/members/me', suresh)).body.data.name).toBe('Suresh Kumar');

    const remove = await call('patch', PH, `/members/${id}`, desk).send({ email: null });
    expect(remove.body.data.appAccess).toMatchObject({ enabled: false, reason: 'no_email' });
    expect((await call('get', PH, '/members/me', suresh)).status).toBe(401);
    // The address is free again inside this gym.
    expect(
      (await call('post', PH, '/staff', owner).send({ name: 'S', email: 'suresh@member.demo' }))
        .status,
    ).toBe(201);
  });

  it('changing name/email updates the login; audit masks personal values', async () => {
    const id = await memberIdOf('powerhouse', ARJUN);
    const res = await call('patch', PH, `/members/${id}`, desk).send({
      name: 'Arjun K. Sharma',
      email: 'arjun.k@member.demo',
      notes: 'Prefers mornings',
    });
    expect(res.status).toBe(200);
    const login = await runInTenant(await gymId('powerhouse'), () =>
      User.findOne({ memberId: id }).lean(),
    );
    expect(login).toMatchObject({ name: 'Arjun K. Sharma', email: 'arjun.k@member.demo' });

    const log = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.findOne({ action: 'member.update' }).lean(),
    );
    expect(log!.changes).toEqual(
      expect.arrayContaining([
        { field: 'name', from: '[hidden]', to: '[hidden]' },
        { field: 'email', from: '[hidden]', to: '[hidden]' },
        { field: 'notes', from: null, to: '[hidden]' },
      ]),
    );
    expect(JSON.stringify(log)).not.toContain('Arjun');
  });

  // ---------------------------------------------------------------- archive
  it('archiving blocks the member app at once; restoring brings it back', async () => {
    const arjun = await memberToken(PH, 'arjun@member.demo');
    const id = await memberIdOf('powerhouse', ARJUN);

    const a = await call('post', PH, `/members/${id}/archive`, owner);
    expect(a.status).toBe(200);
    expect(a.body.data.appAccess).toMatchObject({ enabled: false, reason: 'archived' });
    expect((await call('get', PH, '/members/me', arjun)).status).toBe(401);
    expect((await call('post', PH, `/members/${id}/archive`, owner)).status).toBe(409);
    expect((await call('patch', PH, `/members/${id}`, desk).send({ notes: 'x' })).status).toBe(409);
    // Archived members keep their phone: re-registering is a conflict, restore instead.
    expect(
      (await call('post', PH, '/members', desk).send({ ...newMember, phone: ARJUN })).status,
    ).toBe(409);

    const r = await call('post', PH, `/members/${id}/restore`, owner);
    expect(r.body.data.appAccess.enabled).toBe(true);
    expect(await memberToken(PH, 'arjun@member.demo')).toBeTruthy();
  });

  // ---------------------------------------------------------------- member self-service
  it('a member can update only their own emergency contact, gender and birth date', async () => {
    const arjun = await memberToken(PH, 'arjun@member.demo');
    const res = await call('patch', PH, '/members/me', arjun).send({
      emergencyContact: { name: 'Mom', phone: '9811100000' },
      dateOfBirth: '1990-01-01',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      dateOfBirth: '1990-01-01',
      emergencyContact: { name: 'Mom', phone: '+919811100000', relation: null },
    });
    // Name, phone, notes are not self-editable: stripped, leaving nothing to update.
    expect(
      (await call('patch', PH, '/members/me', arjun).send({ name: 'X', notes: 'vip', phone: '9' }))
        .status,
    ).toBe(422);
    const log = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.findOne({ action: 'member.self_update' }).lean(),
    );
    expect(log!.actor).toMatchObject({ type: 'user', role: 'member' });
  });

  // ---------------------------------------------------------------- authorization
  it('staff read/create/update but cannot archive unless granted; members only see /me', async () => {
    const id = await memberIdOf('powerhouse', PRIYA);
    expect((await call('post', PH, `/members/${id}/archive`, desk)).status).toBe(403);

    const deskId = await runInTenant(await gymId('powerhouse'), async () =>
      String((await User.findOne({ email: 'desk@powerhouse.demo' }).lean())!._id),
    );
    await call('patch', PH, `/staff/${deskId}`, owner).send({ permissions: ['members:archive'] });
    expect((await call('post', PH, `/members/${id}/archive`, desk)).status).toBe(200);

    const arjun = await memberToken(PH, 'arjun@member.demo');
    const arjunId = await memberIdOf('powerhouse', ARJUN);
    expect((await call('get', PH, '/members', arjun)).status).toBe(403);
    expect((await call('post', PH, '/members', arjun).send(newMember)).status).toBe(403);
    // IDOR: not even their own record by id, and certainly not someone else's.
    expect((await call('get', PH, `/members/${arjunId}`, arjun)).status).toBe(403);
    expect((await call('get', PH, `/members/${id}`, arjun)).status).toBe(403);
    expect((await call('patch', PH, `/members/${id}`, arjun).send({ notes: 'x' })).status).toBe(
      403,
    );

    // Staff and owners have no member profile.
    expect((await call('get', PH, '/members/me', desk)).status).toBe(403);
    expect((await call('get', PH, '/members')).status).toBe(401);
  });

  // ---------------------------------------------------------------- cross-tenant
  it("cross-tenant: FitZone can't read, change, archive or find Powerhouse members", async () => {
    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    const phPriya = await memberIdOf('powerhouse', PRIYA);
    expect((await call('get', FZ, `/members/${phPriya}`, fzOwner)).status).toBe(404);
    expect(
      (await call('patch', FZ, `/members/${phPriya}`, fzOwner).send({ notes: 'x' })).status,
    ).toBe(404);
    expect((await call('post', FZ, `/members/${phPriya}/archive`, fzOwner)).status).toBe(404);
    expect((await call('get', FZ, '/members?q=priya', fzOwner)).body.data).toEqual([]);
    expect((await call('get', PH, '/members', fzOwner)).status).toBe(401);

    // Arjun is a member of both gyms with the same phone; each gym sees only its own record.
    const fzArjun = await memberIdOf('fitzone', ARJUN);
    const phArjun = await memberIdOf('powerhouse', ARJUN);
    expect(fzArjun).not.toBe(phArjun);
    const fzMemberToken = await memberToken(FZ, 'arjun@member.demo');
    expect((await call('get', PH, '/members/me', fzMemberToken)).status).toBe(401);
    expect((await call('get', FZ, '/members/me', fzMemberToken)).body.data.memberCode).toBe(
      'M0001',
    );
    expect((await call('get', PH, `/members/${phPriya}`, owner)).body.data.notes).toBeNull();
  });
});
