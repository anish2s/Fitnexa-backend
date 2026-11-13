import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog, PlatformAdmin, Tenant, User } from '../../src/db/models.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { mongoTenantLookup } from '../../src/modules/tenants/tenant.lookup.js';
import { seedDemo } from '../../src/scripts/seed.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { buildTestApp } from '../helpers/app.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';

const PASSWORD = 'demo-Password-123';
const PH = 'powerhouse.localhost';
const FZ = 'fitzone.localhost';
const PLATFORM = 'admin.localhost';

const mailer = memoryMailer();
const app = buildTestApp({
  lookup: mongoTenantLookup,
  mailer,
  env: { AUTH_RATE_LIMIT_MAX: '1000', RATE_LIMIT_MAX: '100000' },
});

// ---------------------------------------------------------------- helpers

async function tokenFor(host: string, identifier: string, password = PASSWORD) {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Host', host)
    .send({ identifier, password });
  if (res.status !== 200) throw new Error(`login ${identifier}@${host}: ${res.status}`);
  return res.body.data.accessToken as string;
}
function lastLinkToken(): string {
  const m = /token=([A-Za-z0-9_-]{43})/.exec(mailer.outbox.at(-1)?.text ?? '');
  if (!m) throw new Error('no link in last email');
  return m[1]!;
}
async function memberToken(host: string, email: string) {
  await request(app).post('/api/v1/auth/magic-link').set('Host', host).send({ email });
  const res = await request(app)
    .post('/api/v1/auth/magic-link/verify')
    .set('Host', host)
    .send({ token: lastLinkToken() });
  return res.body.data.accessToken as string;
}
const call = (method: 'get' | 'post' | 'patch', host: string, path: string, token?: string) => {
  const r = request(app)[method](`/api/v1${path}`).set('Host', host);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
async function gymId(slug: string) {
  return String((await Tenant.findOne({ slug }).lean())!._id);
}
async function gymAudit(slug: string, action?: string) {
  return runInTenant(await gymId(slug), () =>
    AuditLog.find(action ? { action } : {})
      .sort({ createdAt: 1 })
      .lean(),
  );
}

const newGym = {
  name: 'Iron Temple',
  slug: 'irontemple',
  settings: { timezone: 'Asia/Kolkata', gstin: '27AAPFU0939F1ZV' },
  branding: { primaryColor: '#112233', defaultTheme: 'light' },
  subscription: { planCode: 'starter', priceMonthlyPaise: 99900 },
  owner: { name: 'Deepak Rao', email: 'Deepak@IronTemple.demo', phone: '98765 43210' },
};

// ---------------------------------------------------------------- setup

describeWithDb('tenant management, impersonation and audit log (real MongoDB)', () => {
  let admin: string;

  beforeAll(async () => {
    await connectTestDb(`tenants_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
    mailer.clear();
    await seedDemo({ password: PASSWORD });
    admin = await tokenFor(PLATFORM, 'admin@platform.demo');
  });

  // ============================================================ access control
  describeWithDb('platform console access', () => {
    it('401 without a token; gym owner tokens are refused on the platform host', async () => {
      expect((await call('get', PLATFORM, '/platform/tenants')).status).toBe(401);
      const owner = await tokenFor(PH, 'owner@powerhouse.demo');
      expect((await call('get', PLATFORM, '/platform/tenants', owner)).status).toBe(401);
    });

    it('the platform API does not exist on gym hosts, even for a super admin token', async () => {
      const res = await call('get', PH, '/platform/tenants', admin);
      expect(res.status).toBe(401);
    });

    it('a deactivated super admin is refused immediately', async () => {
      await PlatformAdmin.updateOne({ email: 'admin@platform.demo' }, { status: 'disabled' });
      expect((await call('get', PLATFORM, '/platform/tenants', admin)).status).toBe(401);
    });
  });

  // ============================================================ list / slug / get
  describeWithDb('list, slug checks, detail', () => {
    it('lists gyms with search and pagination', async () => {
      const all = await call('get', PLATFORM, '/platform/tenants', admin);
      expect(all.status).toBe(200);
      expect(all.body.data.map((t: { slug: string }) => t.slug).sort()).toEqual([
        'fitzone',
        'powerhouse',
      ]);
      expect(all.body.meta).toMatchObject({ page: 1, total: 2 });

      const searched = await call('get', PLATFORM, '/platform/tenants?q=power', admin);
      expect(searched.body.data).toHaveLength(1);
      // Regex metacharacters are escaped, not interpreted.
      const rx = await call('get', PLATFORM, '/platform/tenants?q=.*', admin);
      expect(rx.body.data).toHaveLength(0);

      const paged = await call('get', PLATFORM, '/platform/tenants?limit=1&page=2', admin);
      expect(paged.body.data).toHaveLength(1);
      expect(paged.body.meta).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });

      expect((await call('get', PLATFORM, '/platform/tenants?limit=500', admin)).status).toBe(422);
    });

    it('reports slug problems: invalid, reserved, taken, punycode-like', async () => {
      const check = async (slug: string) =>
        (await call('get', PLATFORM, `/platform/tenants/slug-availability?slug=${slug}`, admin))
          .body.data;
      expect(await check('newgym')).toMatchObject({ available: true, reason: null });
      expect(await check('admin')).toMatchObject({ available: false, reason: 'reserved' });
      expect(await check('powerhouse')).toMatchObject({ available: false, reason: 'taken' });
      expect(await check('xn--abc')).toMatchObject({ available: false, reason: 'invalid' });
      expect(await check('bad_slug')).toMatchObject({ available: false, reason: 'invalid' });
    });

    it('shows one gym with owners and user counts; 404 unknown, 422 malformed id', async () => {
      const id = await gymId('powerhouse');
      const res = await call('get', PLATFORM, `/platform/tenants/${id}`, admin);
      expect(res.status).toBe(200);
      expect(res.body.data.tenant).toMatchObject({ slug: 'powerhouse', status: 'active' });
      expect(res.body.data.owners).toHaveLength(1);
      expect(res.body.data.owners[0]).toMatchObject({ email: 'owner@powerhouse.demo' });
      expect(res.body.data.userCounts).toEqual({ owner: 1, staff: 1, member: 3 });
      expect(res.body.data.appUrl).toBe('http://powerhouse.localhost:3000');

      const missing = new mongoose.Types.ObjectId().toHexString();
      expect((await call('get', PLATFORM, `/platform/tenants/${missing}`, admin)).status).toBe(404);
      expect((await call('get', PLATFORM, '/platform/tenants/nope', admin)).status).toBe(422);
    });
  });

  // ============================================================ create
  describeWithDb('create gym + owner invite', () => {
    it('creates the gym and an invited owner, emails the invite, and the owner can sign in', async () => {
      const res = await call('post', PLATFORM, '/platform/tenants', admin).send(newGym);
      expect(res.status).toBe(201);
      expect(res.body.data.tenant).toMatchObject({
        slug: 'irontemple',
        status: 'active',
        email: 'deepak@irontemple.demo',
        settings: { gstin: '27AAPFU0939F1ZV', receiptPrefix: 'RCPT' },
        branding: { primaryColor: '#112233', defaultTheme: 'light' },
        subscription: { planCode: 'starter', priceMonthlyPaise: 99900 },
      });
      expect(res.body.data.owner).toMatchObject({ status: 'invited' });
      expect(res.body.data.inviteSent).toBe(true);

      const mail = mailer.outbox.at(-1)!;
      expect(mail.to).toBe('deepak@irontemple.demo');
      expect(mail.text).toContain('http://irontemple.localhost:3000/');

      // Invite → set password on the NEW gym's host → normal login.
      const host = 'irontemple.localhost';
      const accept = await request(app)
        .post('/api/v1/auth/password/reset')
        .set('Host', host)
        .send({ token: lastLinkToken(), password: 'Brand-New-Pass-1' });
      expect(accept.status).toBe(204);
      const owner = await tokenFor(host, '9876543210', 'Brand-New-Pass-1');
      expect((await call('get', host, '/gym', owner)).body.data.slug).toBe('irontemple');
      // ...and nowhere else.
      expect((await call('get', PH, '/gym', owner)).status).toBe(401);

      const log = await gymAudit('irontemple');
      expect(log.map((e) => e.action)).toEqual(
        expect.arrayContaining(['tenant.create', 'auth.invite_accepted', 'auth.login']),
      );
      const created = log.find((e) => e.action === 'tenant.create')!;
      expect(created.actor).toMatchObject({ type: 'platform_admin', name: 'Platform Admin' });
    });

    it('409 for a taken or reserved slug; nothing is created', async () => {
      const taken = await call('post', PLATFORM, '/platform/tenants', admin).send({
        ...newGym,
        slug: 'powerhouse',
      });
      expect(taken.status).toBe(409);
      expect(taken.body.error.details).toMatchObject({ field: 'slug', reason: 'taken' });
      const reserved = await call('post', PLATFORM, '/platform/tenants', admin).send({
        ...newGym,
        slug: 'admin',
      });
      expect(reserved.status).toBe(409);
      expect(await Tenant.countDocuments()).toBe(2);
    });

    it('422 for invalid input (no owner email, bad colour, bad GSTIN, http logo)', async () => {
      for (const body of [
        { ...newGym, owner: { name: 'X' } },
        { ...newGym, branding: { primaryColor: 'red' } },
        { ...newGym, settings: { gstin: '12345' } },
        { ...newGym, branding: { logoUrl: 'http://insecure.example/logo.png' } },
        { ...newGym, subscription: { priceMonthlyPaise: 99.5 } },
      ]) {
        const res = await call('post', PLATFORM, '/platform/tenants', admin).send(body);
        expect(res.status, JSON.stringify(body)).toBe(422);
      }
      expect(await Tenant.countDocuments()).toBe(2);
    });

    it('resending the invite works only while the owner has not accepted', async () => {
      const id = (await call('post', PLATFORM, '/platform/tenants', admin).send(newGym)).body.data
        .tenant.id;
      const resend = await call('post', PLATFORM, `/platform/tenants/${id}/owner-invite`, admin);
      expect(resend.status).toBe(202);

      const ph = await gymId('powerhouse');
      const none = await call('post', PLATFORM, `/platform/tenants/${ph}/owner-invite`, admin);
      expect(none.status).toBe(409);
    });
  });

  // ============================================================ update / branding
  describeWithDb('super admin edits', () => {
    it('patches one setting without wiping the others, and audits field changes', async () => {
      const id = await gymId('powerhouse');
      await call('patch', PLATFORM, `/platform/tenants/${id}`, admin).send({
        settings: { gstin: '27AAPFU0939F1ZV' },
      });
      const res = await call('patch', PLATFORM, `/platform/tenants/${id}`, admin).send({
        settings: { renewalReminderDays: 3 },
        email: 'new@powerhouse.demo',
        subscription: { status: 'active' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.settings).toMatchObject({
        gstin: '27AAPFU0939F1ZV',
        renewalReminderDays: 3,
      });
      expect(res.body.data.subscription.status).toBe('active');

      const entry = (await gymAudit('powerhouse', 'tenant.update')).at(-1)!;
      expect(entry.changes).toEqual(
        expect.arrayContaining([
          { field: 'settings.renewalReminderDays', from: 7, to: 3 },
          // Personal data is not copied into the log.
          { field: 'email', from: '[hidden]', to: '[hidden]' },
        ]),
      );
    });

    it('branding update shows on the public branding endpoint', async () => {
      const id = await gymId('fitzone');
      const res = await call('patch', PLATFORM, `/platform/tenants/${id}/branding`, admin).send({
        primaryColor: '#ABCDEF',
      });
      expect(res.status).toBe(200);
      const pub = await call('get', FZ, '/public/tenant');
      expect(pub.body.data.branding.primaryColor).toBe('#ABCDEF');
    });

    it('422 for an empty patch', async () => {
      const id = await gymId('fitzone');
      expect(
        (await call('patch', PLATFORM, `/platform/tenants/${id}`, admin).send({})).status,
      ).toBe(422);
    });
  });

  // ============================================================ suspend / activate
  describeWithDb('suspend and activate', () => {
    it("blocks the gym's next request, keeps the other gym working, and activation restores it", async () => {
      const owner = await tokenFor(PH, 'owner@powerhouse.demo');
      const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
      const id = await gymId('powerhouse');

      const s = await call('post', PLATFORM, `/platform/tenants/${id}/suspend`, admin).send({
        reason: 'Unpaid invoice',
      });
      expect(s.status).toBe(200);
      expect(s.body.data).toMatchObject({ status: 'suspended', suspendedReason: 'Unpaid invoice' });

      const blocked = await call('get', PH, '/gym', owner);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('TENANT_SUSPENDED');
      expect((await call('get', FZ, '/gym', fzOwner)).status).toBe(200);

      // Double suspend is a conflict.
      expect(
        (
          await call('post', PLATFORM, `/platform/tenants/${id}/suspend`, admin).send({
            reason: 'again',
          })
        ).status,
      ).toBe(409);

      const a = await call('post', PLATFORM, `/platform/tenants/${id}/activate`, admin);
      expect(a.status).toBe(200);
      expect(a.body.data).toMatchObject({ status: 'active', suspendedReason: null });
      // Same session works again: sessions were kept.
      expect((await call('get', PH, '/gym', owner)).status).toBe(200);
      expect((await call('post', PLATFORM, `/platform/tenants/${id}/activate`, admin)).status).toBe(
        409,
      );

      const actions = (await gymAudit('powerhouse')).map((e) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['tenant.suspend', 'tenant.activate']));
    });

    it('422 without a reason', async () => {
      const id = await gymId('powerhouse');
      const res = await call('post', PLATFORM, `/platform/tenants/${id}/suspend`, admin).send({});
      expect(res.status).toBe(422);
    });
  });

  // ============================================================ impersonation
  describeWithDb('log in as owner', () => {
    async function impersonate(slug = 'powerhouse') {
      const id = await gymId(slug);
      return call('post', PLATFORM, `/platform/tenants/${id}/impersonate`, admin).send({
        reason: 'Support ticket #4521',
      });
    }

    it('issues an owner token for that gym only, flagged in /me, with no refresh cookie', async () => {
      const res = await impersonate();
      expect(res.status).toBe(201);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
      const token = res.body.data.accessToken as string;

      const me = await call('get', PH, '/auth/me', token);
      expect(me.status).toBe(200);
      expect(me.body.data.user.role).toBe('owner');
      expect(me.body.data.impersonatedBy).toMatchObject({ name: 'Platform Admin' });

      expect((await call('get', FZ, '/auth/me', token)).status).toBe(401);
      expect((await call('get', PLATFORM, '/auth/me', token)).status).toBe(401);
    });

    it("can't change the owner's credentials or end the owner's real sessions", async () => {
      const token = (await impersonate()).body.data.accessToken as string;
      const change = await call('post', PH, '/auth/password/change', token).send({
        currentPassword: PASSWORD,
        newPassword: 'Another-Pass-123',
      });
      expect(change.status).toBe(403);
      expect((await call('post', PH, '/auth/logout-all', token)).status).toBe(403);
    });

    it('every action is audited with the impersonator, and the owner can read it', async () => {
      const token = (await impersonate()).body.data.accessToken as string;
      await call('patch', PH, '/gym', token).send({ settings: { renewalReminderDays: 5 } });
      await call('post', PH, '/auth/impersonation/end', token);

      const owner = await tokenFor(PH, 'owner@powerhouse.demo');
      const log = await call('get', PH, '/audit-logs?limit=100', owner);
      expect(log.status).toBe(200);
      const byAction = Object.fromEntries(
        log.body.data.map((e: { action: string }) => [e.action, e]),
      );
      expect(byAction['impersonation.start']).toMatchObject({
        actor: { type: 'platform_admin' },
        metadata: { reason: 'Support ticket #4521' },
      });
      expect(byAction['gym.update']).toMatchObject({
        actor: { type: 'user', role: 'owner' },
        impersonator: { name: 'Platform Admin' },
      });
      expect(byAction['impersonation.end']).toBeTruthy();
    });

    it('the token dies when the session is ended or the super admin is deactivated', async () => {
      const t1 = (await impersonate()).body.data.accessToken as string;
      expect((await call('post', PH, '/auth/impersonation/end', t1)).status).toBe(204);
      expect((await call('get', PH, '/auth/me', t1)).status).toBe(401);

      const t2 = (await impersonate()).body.data.accessToken as string;
      await PlatformAdmin.updateOne({ email: 'admin@platform.demo' }, { status: 'disabled' });
      expect((await call('get', PH, '/auth/me', t2)).status).toBe(401);
    });

    it('a normal owner session cannot call impersonation/end', async () => {
      const owner = await tokenFor(PH, 'owner@powerhouse.demo');
      expect((await call('post', PH, '/auth/impersonation/end', owner)).status).toBe(400);
    });

    it('409 for a suspended gym; 422 for a weak reason', async () => {
      const id = await gymId('powerhouse');
      const short = await call('post', PLATFORM, `/platform/tenants/${id}/impersonate`, admin).send(
        { reason: 'help' },
      );
      expect(short.status).toBe(422);
      await call('post', PLATFORM, `/platform/tenants/${id}/suspend`, admin).send({
        reason: 'Unpaid invoice',
      });
      expect((await impersonate()).status).toBe(409);
    });
  });

  // ============================================================ the owner's own gym
  describeWithDb('/gym (owner settings)', () => {
    it('owner reads and updates their own gym; staff can read only; members neither', async () => {
      const owner = await tokenFor(PH, 'owner@powerhouse.demo');
      const staff = await tokenFor(PH, 'desk@powerhouse.demo');
      const member = await memberToken(PH, 'arjun@member.demo');

      expect((await call('get', PH, '/gym', owner)).body.data.slug).toBe('powerhouse');
      expect((await call('get', PH, '/gym', staff)).status).toBe(200);
      expect((await call('get', PH, '/gym', member)).status).toBe(403);
      expect((await call('get', PH, '/gym')).status).toBe(401);

      const upd = await call('patch', PH, '/gym', owner).send({ name: 'Powerhouse Gym' });
      expect(upd.status).toBe(200);
      expect(upd.body.data.name).toBe('Powerhouse Gym');
      for (const t of [staff, member]) {
        expect((await call('patch', PH, '/gym', t).send({ name: 'Hacked' })).status).toBe(403);
        expect(
          (await call('patch', PH, '/gym/branding', t).send({ primaryColor: '#000000' })).status,
        ).toBe(403);
      }
      expect((await gymAudit('powerhouse', 'gym.update')).at(-1)!.changes).toEqual([
        { field: 'name', from: 'Powerhouse Fitness', to: 'Powerhouse Gym' },
      ]);
    });

    it('422 for invalid settings and for an empty body', async () => {
      const owner = await tokenFor(PH, 'owner@powerhouse.demo');
      for (const body of [
        {},
        { settings: { timezone: 'Mars/Olympus' } },
        { settings: { renewalReminderDays: 999 } },
      ]) {
        expect((await call('patch', PH, '/gym', owner).send(body)).status).toBe(422);
      }
    });

    it('cross-tenant: an id, slug or status in the body cannot redirect or escalate the update', async () => {
      const owner = await tokenFor(PH, 'owner@powerhouse.demo');
      const fz = await gymId('fitzone');
      const res = await call('patch', PH, '/gym', owner).send({
        name: 'Still Powerhouse',
        tenantId: fz,
        _id: fz,
        slug: 'fitzone',
        status: 'suspended',
        subscription: { status: 'active' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ slug: 'powerhouse', status: 'active' });
      expect((await Tenant.findById(fz).lean())!.name).toBe('FitZone');
    });

    it("cross-tenant: a FitZone owner's token is refused on Powerhouse", async () => {
      const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
      expect((await call('get', PH, '/gym', fzOwner)).status).toBe(401);
      expect((await call('patch', PH, '/gym', fzOwner).send({ name: 'X' })).status).toBe(401);
    });
  });

  // ============================================================ audit log
  describeWithDb('audit log', () => {
    it("each gym sees only its own log; staff and members can't read it", async () => {
      const ph = await tokenFor(PH, 'owner@powerhouse.demo');
      const fz = await tokenFor(FZ, 'owner@fitzone.demo');
      await call('patch', PH, '/gym', ph).send({ name: 'PH Renamed' });

      const phLog = await call('get', PH, '/audit-logs?action=gym.update', ph);
      expect(phLog.status).toBe(200);
      expect(phLog.body.data).toHaveLength(1);
      const fzLog = await call('get', FZ, '/audit-logs?action=gym.update', fz);
      expect(fzLog.body.data).toHaveLength(0);

      const staff = await tokenFor(PH, 'desk@powerhouse.demo');
      expect((await call('get', PH, '/audit-logs', staff)).status).toBe(403);
      expect((await call('get', PH, '/audit-logs?action=DROP', ph)).status).toBe(422);
    });

    it('super admin reads a gym log and the platform log (logins land there)', async () => {
      const id = await gymId('powerhouse');
      await tokenFor(PH, 'owner@powerhouse.demo');
      const gymLog = await call('get', PLATFORM, `/platform/tenants/${id}/audit-logs`, admin);
      expect(gymLog.status).toBe(200);
      expect(gymLog.body.data.map((e: { action: string }) => e.action)).toContain('auth.login');

      const platformLog = await call('get', PLATFORM, '/platform/audit-logs', admin);
      expect(platformLog.body.data[0]).toMatchObject({
        action: 'auth.login',
        actor: { type: 'platform_admin' },
      });
    });

    it('is append-only at the model layer', async () => {
      const id = await gymId('powerhouse');
      await runInTenant(id, async () => {
        await expect(AuditLog.updateMany({}, { action: 'x.y' })).rejects.toThrow(/append-only/);
        await expect(AuditLog.deleteMany({})).rejects.toThrow(/append-only/);
      });
    });

    it('failed logins that lock an account are recorded', async () => {
      const id = await gymId('powerhouse');
      for (let i = 0; i < 10; i++) {
        await request(app)
          .post('/api/v1/auth/login')
          .set('Host', PH)
          .send({ identifier: 'desk@powerhouse.demo', password: 'wrong-wrong-wrong' });
      }
      const locked = await runInTenant(id, () =>
        AuditLog.countDocuments({ action: 'auth.account_locked' }),
      );
      expect(locked).toBe(1);
      // The staff user is unchanged otherwise.
      expect(
        await runInTenant(id, () => User.countDocuments({ email: 'desk@powerhouse.demo' })),
      ).toBe(1);
    });
  });
});
