import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog, Session, User } from '../../src/db/models.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

const { mailer, call, tokenFor, memberToken, lastLinkToken } = intApp();

async function staffId(slug: string, email: string) {
  return runInTenant(await gymId(slug), async () =>
    String((await User.findOne({ email }).lean())!._id),
  );
}

describeWithDb('staff management (real MongoDB)', () => {
  let owner: string;
  let desk: string;

  beforeAll(async () => {
    await connectTestDb(`staff_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
  });

  it('owner lists the team (owner + staff, never members) with effective permissions', async () => {
    const res = await call('get', PH, '/staff', owner);
    expect(res.status).toBe(200);
    expect(res.body.data.map((u: { email: string }) => u.email)).toEqual([
      'owner@powerhouse.demo',
      'desk@powerhouse.demo',
    ]);
    const deskRow = res.body.data[1];
    expect(deskRow).toMatchObject({ role: 'staff', grants: [] });
    expect(deskRow.permissions).toContain('payments:record');
    expect(deskRow.permissions).not.toContain('reports:read');
    expect(res.body.meta).toMatchObject({ total: 2 });

    const search = await call('get', PH, '/staff?q=sneha', owner);
    expect(search.body.data).toHaveLength(1);
  });

  it('creates invited staff with grants, emails the invite, and they can sign in after accepting', async () => {
    const res = await call('post', PH, '/staff', owner).send({
      name: 'Kiran Desai',
      email: 'Kiran@Powerhouse.demo',
      phone: '98000 00009',
      permissions: ['reports:read', 'reports:read', 'payments:refund'],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.staff).toMatchObject({
      status: 'invited',
      email: 'kiran@powerhouse.demo',
      phone: '+919800000009',
      grants: ['payments:refund', 'reports:read'],
    });
    expect(res.body.data.inviteSent).toBe(true);
    expect(mailer.outbox.at(-1)!.to).toBe('kiran@powerhouse.demo');

    const accept = await call('post', PH, '/auth/password/reset').send({
      token: lastLinkToken(),
      password: 'Kiran-Pass-12345',
    });
    expect(accept.status).toBe(204);
    const kiran = await tokenFor(PH, 'kiran@powerhouse.demo', 'Kiran-Pass-12345');
    const me = await call('get', PH, '/auth/me', kiran);
    expect(me.body.data.user.permissions).toEqual(expect.arrayContaining(['reports:read']));

    const log = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.findOne({ action: 'staff.create' }).lean(),
    );
    expect(log!.metadata).toMatchObject({ grants: ['payments:refund', 'reports:read'] });
  });

  it('422: missing email, bad phone, ungrantable permission', async () => {
    for (const body of [
      { name: 'No Email', phone: '9800000010' },
      { name: 'Bad', email: 'x@y.in', phone: '12' },
      { name: 'Escalate', email: 'x@y.in', permissions: ['staff:manage'] },
      { name: 'Escalate', email: 'x@y.in', permissions: ['audit:read'] },
    ]) {
      expect(
        (await call('post', PH, '/staff', owner).send(body)).status,
        JSON.stringify(body),
      ).toBe(422);
    }
  });

  it('409 when the email or phone is already used in this gym (any role), allowed in another gym', async () => {
    const dupe = await call('post', PH, '/staff', owner).send({
      name: 'Dup',
      email: 'arjun@member.demo',
    });
    expect(dupe.status).toBe(409);
    expect(JSON.stringify(dupe.body)).not.toContain('arjun@member.demo');

    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    const otherGym = await call('post', FZ, '/staff', fzOwner).send({
      name: 'Sneha again',
      email: 'desk@powerhouse.demo',
    });
    expect(otherGym.status).toBe(201);
  });

  it('updates grants and profile; changes are audited with personal values masked', async () => {
    const id = await staffId('powerhouse', 'desk@powerhouse.demo');
    const res = await call('patch', PH, `/staff/${id}`, owner).send({
      permissions: ['reports:read'],
      phone: '9800000077',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.grants).toEqual(['reports:read']);
    // Takes effect on the staff member's very next request (permissions re-read per request).
    expect((await call('get', PH, '/auth/me', desk)).body.data.user.permissions).toContain(
      'reports:read',
    );

    const log = await runInTenant(await gymId('powerhouse'), () =>
      AuditLog.findOne({ action: 'staff.permissions_update' }).lean(),
    );
    expect(log!.changes).toEqual(
      expect.arrayContaining([
        { field: 'permissions', from: [], to: ['reports:read'] },
        { field: 'phone', from: '[hidden]', to: '[hidden]' },
      ]),
    );
    expect((await call('patch', PH, `/staff/${id}`, owner).send({})).status).toBe(422);
  });

  it('deactivation is immediate and ends every session; activation restores sign-in', async () => {
    const id = await staffId('powerhouse', 'desk@powerhouse.demo');
    const res = await call('post', PH, `/staff/${id}/deactivate`, owner);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('disabled');
    expect((await call('get', PH, '/auth/me', desk)).status).toBe(401);
    expect(
      await runInTenant(await gymId('powerhouse'), () =>
        Session.countDocuments({ userId: id, revokedAt: null }),
      ),
    ).toBe(0);
    expect((await call('post', PH, `/staff/${id}/deactivate`, owner)).status).toBe(409);

    const back = await call('post', PH, `/staff/${id}/activate`, owner);
    expect(back.body.data.status).toBe('active');
    expect(await tokenFor(PH, 'desk@powerhouse.demo')).toBeTruthy();
  });

  it('resends an invite only while it is pending', async () => {
    const created = await call('post', PH, '/staff', owner).send({ name: 'New', email: 'n@ph.in' });
    const id = created.body.data.staff.id;
    expect((await call('post', PH, `/staff/${id}/invite`, owner)).status).toBe(202);
    const active = await staffId('powerhouse', 'desk@powerhouse.demo');
    expect((await call('post', PH, `/staff/${active}/invite`, owner)).status).toBe(409);
  });

  // ---------------------------------------------------------------- authorization
  it('staff and members cannot read or manage the team; no token is 401', async () => {
    const member = await memberToken(PH, 'arjun@member.demo');
    const id = await staffId('powerhouse', 'desk@powerhouse.demo');
    for (const t of [desk, member]) {
      expect((await call('get', PH, '/staff', t)).status).toBe(403);
      expect(
        (await call('post', PH, '/staff', t).send({ name: 'X', email: 'x@y.in' })).status,
      ).toBe(403);
      expect((await call('post', PH, `/staff/${id}/deactivate`, t)).status).toBe(403);
    }
    expect((await call('get', PH, '/staff')).status).toBe(401);
  });

  it('a staff member granted extra permissions still cannot manage staff', async () => {
    const id = await staffId('powerhouse', 'desk@powerhouse.demo');
    await call('patch', PH, `/staff/${id}`, owner).send({
      permissions: ['reports:read', 'members:archive'],
    });
    expect((await call('get', PH, '/staff', desk)).status).toBe(403);
    expect((await call('patch', PH, `/staff/${id}`, desk).send({ permissions: [] })).status).toBe(
      403,
    );
  });

  // ---------------------------------------------------------------- IDOR & cross-tenant
  it("IDOR: the owner's own account and members can't be edited or deactivated via /staff", async () => {
    const ownerId = await staffId('powerhouse', 'owner@powerhouse.demo');
    const memberId = await staffId('powerhouse', 'arjun@member.demo');
    expect((await call('get', PH, `/staff/${ownerId}`, owner)).status).toBe(200);
    for (const id of [ownerId, memberId]) {
      expect((await call('patch', PH, `/staff/${id}`, owner).send({ name: 'X' })).status).toBe(404);
      expect((await call('post', PH, `/staff/${id}/deactivate`, owner)).status).toBe(404);
    }
    expect((await call('get', PH, `/staff/${memberId}`, owner)).status).toBe(404);
  });

  it("cross-tenant: FitZone's owner can't see or touch Powerhouse staff by id", async () => {
    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    const phDesk = await staffId('powerhouse', 'desk@powerhouse.demo');
    expect((await call('get', FZ, `/staff/${phDesk}`, fzOwner)).status).toBe(404);
    expect((await call('patch', FZ, `/staff/${phDesk}`, fzOwner).send({ name: 'X' })).status).toBe(
      404,
    );
    expect((await call('post', FZ, `/staff/${phDesk}/deactivate`, fzOwner)).status).toBe(404);
    // And a FitZone token is refused on the Powerhouse host outright.
    expect((await call('get', PH, '/staff', fzOwner)).status).toBe(401);
    // Powerhouse desk is untouched.
    expect((await call('get', PH, '/auth/me', desk)).status).toBe(200);
  });
});
