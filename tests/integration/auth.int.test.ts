import { SignJWT } from 'jose';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { memoryMailer } from '../../src/lib/mailer.js';
import { AuthToken, PlatformAdmin, Session, Tenant, User } from '../../src/db/models.js';
import { mongoTenantLookup } from '../../src/modules/tenants/tenant.lookup.js';
import { seedDemo } from '../../src/scripts/seed.js';
import { runAsPlatform, runInTenant } from '../../src/tenancy/context.js';
import { buildTestApp } from '../helpers/app.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';

const PASSWORD = 'demo-Password-123';
const PH = 'powerhouse.localhost';
const FZ = 'fitzone.localhost';
const PLATFORM = 'admin.localhost';
const COOKIE = 'gym_rt';

const mailer = memoryMailer();
const lenient = { AUTH_RATE_LIMIT_MAX: '1000', RATE_LIMIT_MAX: '100000' };
const app = buildTestApp({ lookup: mongoTenantLookup, mailer, env: lenient });

// ---------------------------------------------------------------- helpers

function login(host: string, identifier: string, password = PASSWORD, a = app) {
  return request(a).post('/api/v1/auth/login').set('Host', host).send({ identifier, password });
}
function refreshCookieOf(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = raw?.find((h) => h.startsWith(`${COOKIE}=`));
  const value = c?.split(';')[0]!.slice(COOKIE.length + 1);
  return value || undefined;
}
function me(host: string, token: string) {
  return request(app)
    .get('/api/v1/auth/me')
    .set('Host', host)
    .set('Authorization', `Bearer ${token}`);
}
function refresh(host: string, cookie: string) {
  return request(app)
    .post('/api/v1/auth/refresh')
    .set('Host', host)
    .set('Cookie', `${COOKIE}=${cookie}`);
}
function lastLinkToken(): string {
  const text = mailer.outbox.at(-1)?.text ?? '';
  const m = /token=([A-Za-z0-9_-]{43})/.exec(text);
  if (!m) throw new Error('no link in last email');
  return m[1]!;
}
async function gymId(slug: string) {
  return (await Tenant.findOne({ slug }).lean())!._id;
}
async function asGym<T>(slug: string, fn: () => Promise<T>) {
  return runInTenant(await gymId(slug), fn);
}

// ---------------------------------------------------------------- setup

describeWithDb('authentication (real MongoDB)', () => {
  beforeAll(async () => {
    await connectTestDb(`auth_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
    mailer.clear();
    await seedDemo({ password: PASSWORD });
  });

  // ============================================================ password login
  describeWithDb('owner / staff password login', () => {
    it('owner signs in by email; refresh token is an HttpOnly cookie, never in the body', async () => {
      const res = await login(PH, 'Owner@Powerhouse.demo');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      expect(res.body.data.user).toMatchObject({ role: 'owner', email: 'owner@powerhouse.demo' });
      expect(res.body.data.user.permissions).toEqual(
        expect.arrayContaining(['reports:read', 'staff:manage']),
      );
      expect(JSON.stringify(res.body)).not.toMatch(/refresh/i);
      const setCookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Lax/);
      expect(setCookie).toMatch(/Path=\//);
      expect(setCookie).not.toMatch(/Domain=/);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('staff signs in with a loosely typed Indian mobile number and gets front-desk permissions only', async () => {
      const res = await login(PH, '98000 00002');
      expect(res.status).toBe(200);
      const perms: string[] = res.body.data.user.permissions;
      expect(perms).toEqual(
        expect.arrayContaining(['members:create', 'payments:record', 'attendance:checkin']),
      );
      for (const p of [
        'reports:read',
        'staff:manage',
        'payments:refund',
        'plans:manage',
        'branding:update',
      ]) {
        expect(perms).not.toContain(p);
      }
    });

    it('unknown account and wrong password are indistinguishable', async () => {
      const wrong = await login(PH, 'owner@powerhouse.demo', 'nope-nope-nope');
      const unknown = await login(PH, 'ghost@powerhouse.demo', 'nope-nope-nope');
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body.error.message).toBe(wrong.body.error.message);
    });

    it('members cannot use password login', async () => {
      expect((await login(PH, 'arjun@member.demo')).status).toBe(401);
    });

    it("Gym A owner's credentials do not work on Gym B's host", async () => {
      const res = await login(FZ, 'owner@powerhouse.demo');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('locks the account after 5 wrong passwords, even for the right password', async () => {
      for (let i = 0; i < 5; i++)
        expect((await login(PH, 'desk@powerhouse.demo', 'wrong-password')).status).toBe(401);
      const res = await login(PH, 'desk@powerhouse.demo');
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('LOGIN_LOCKED');
      // The same staff email at a different gym is a different account and is unaffected.
      expect((await login(FZ, 'owner@fitzone.demo')).status).toBe(200);
    });

    it('resets the failure counter after a successful login', async () => {
      for (let i = 0; i < 4; i++) await login(PH, 'desk@powerhouse.demo', 'wrong-password');
      expect((await login(PH, 'desk@powerhouse.demo')).status).toBe(200);
      for (let i = 0; i < 4; i++) await login(PH, 'desk@powerhouse.demo', 'wrong-password');
      expect((await login(PH, 'desk@powerhouse.demo')).status).toBe(200);
    });

    it('tells a disabled user why, but only after a correct password', async () => {
      await asGym('powerhouse', () =>
        User.updateOne({ email: 'desk@powerhouse.demo' }, { status: 'disabled' }),
      );
      expect((await login(PH, 'desk@powerhouse.demo', 'wrong-password')).body.error.code).toBe(
        'INVALID_CREDENTIALS',
      );
      const res = await login(PH, 'desk@powerhouse.demo');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
    });

    it('blocks login at a suspended gym', async () => {
      await Tenant.updateOne({ slug: 'powerhouse' }, { status: 'suspended' });
      const res = await login(PH, 'owner@powerhouse.demo');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('TENANT_SUSPENDED');
    });

    it('rate-limits repeated attempts on one account', async () => {
      const strict = buildTestApp({
        lookup: mongoTenantLookup,
        mailer,
        env: { AUTH_RATE_LIMIT_MAX: '3' },
      });
      for (let i = 0; i < 3; i++) await login(PH, 'owner@powerhouse.demo', 'wrong', strict);
      const res = await login(PH, 'owner@powerhouse.demo', 'wrong', strict);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });

    it('rejects malformed input with field errors', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Host', PH)
        .send({ identifier: 'x' });
      expect(res.status).toBe(422);
      expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(
        expect.arrayContaining(['identifier', 'password']),
      );
    });
  });

  // ============================================================ token binding
  describeWithDb('access token binding', () => {
    it('works on its own gym host', async () => {
      const { accessToken } = (await login(PH, 'owner@powerhouse.demo')).body.data;
      const res = await me(PH, accessToken);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ scope: 'tenant', gym: { slug: 'powerhouse' } });
    });

    it("CROSS-TENANT: a Gym A token is rejected on Gym B's host", async () => {
      const { accessToken } = (await login(PH, 'owner@powerhouse.demo')).body.data;
      const res = await me(FZ, accessToken);
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toMatch(/powerhouse|Rahul/i);
    });

    it('gym tokens are rejected on the platform host and platform tokens on gym hosts', async () => {
      const gym = (await login(PH, 'owner@powerhouse.demo')).body.data.accessToken;
      const platform = (await login(PLATFORM, 'admin@platform.demo')).body.data.accessToken;
      expect((await me(PLATFORM, gym)).status).toBe(401);
      expect((await me(PH, platform)).status).toBe(401);
    });

    it('rejects a token re-signed with a forged tenant, alg=none, or no token at all', async () => {
      const { accessToken } = (await login(PH, 'owner@powerhouse.demo')).body.data;
      const [h, p] = accessToken.split('.');
      const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
      const forged = Buffer.from(
        JSON.stringify({ ...payload, tid: String(await gymId('fitzone')) }),
      ).toString('base64url');
      expect((await me(FZ, `${h}.${forged}.${accessToken.split('.')[2]}`)).status).toBe(401);

      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
      expect((await me(PH, none)).status).toBe(401);

      const wrongKey = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256' })
        .sign(new TextEncoder().encode('x'.repeat(64)));
      expect((await me(PH, wrongKey)).status).toBe(401);

      expect((await request(app).get('/api/v1/auth/me').set('Host', PH)).status).toBe(401);
    });

    it('reports TOKEN_EXPIRED so the client knows to refresh', async () => {
      const { accessToken } = (await login(PH, 'owner@powerhouse.demo')).body.data;
      const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
      const past = Math.floor(Date.now() / 1000) - 3600;
      // Same key, same claims, same live session: only the expiry differs.
      const expired = await new SignJWT({ ...claims, iat: past, exp: past + 60 })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET));
      const res = await me(PH, expired);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_EXPIRED');
    });

    it('takes role changes and disabling from the database on the next request', async () => {
      const { accessToken } = (await login(PH, 'owner@powerhouse.demo')).body.data;
      await asGym('powerhouse', () =>
        User.updateOne({ email: 'owner@powerhouse.demo' }, { role: 'staff' }),
      );
      expect((await me(PH, accessToken)).body.data.user.permissions).not.toContain('reports:read');
      await asGym('powerhouse', () =>
        User.updateOne({ email: 'owner@powerhouse.demo' }, { status: 'disabled' }),
      );
      expect((await me(PH, accessToken)).status).toBe(401);
    });

    it('blocks a valid token once the gym is suspended', async () => {
      const { accessToken } = (await login(PH, 'owner@powerhouse.demo')).body.data;
      await Tenant.updateOne({ slug: 'powerhouse' }, { status: 'suspended' });
      expect((await me(PH, accessToken)).body.error.code).toBe('TENANT_SUSPENDED');
    });
  });

  // ============================================================ super admin
  describeWithDb('super admin', () => {
    it('signs in only on the platform host', async () => {
      const ok = await login(PLATFORM, 'admin@platform.demo');
      expect(ok.status).toBe(200);
      expect(ok.body.data.user.permissions).toEqual([]);
      expect((await me(PLATFORM, ok.body.data.accessToken)).body.data).toMatchObject({
        scope: 'platform',
        gym: null,
      });
      expect((await login(PH, 'admin@platform.demo')).status).toBe(401);
    });

    it('gym owners cannot sign in on the platform host', async () => {
      expect((await login(PLATFORM, 'owner@powerhouse.demo')).status).toBe(401);
    });

    it('platform admins are not visible to gym-scoped queries', async () => {
      expect(await PlatformAdmin.countDocuments()).toBe(1);
      expect(
        await asGym('powerhouse', () => User.countDocuments({ email: 'admin@platform.demo' })),
      ).toBe(0);
    });
  });

  // ============================================================ sessions
  describeWithDb('refresh, rotation and logout', () => {
    it('rotates the refresh token on every use', async () => {
      const first = refreshCookieOf(await login(PH, 'owner@powerhouse.demo'))!;
      const res = await refresh(PH, first);
      expect(res.status).toBe(200);
      const second = refreshCookieOf(res)!;
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      expect((await me(PH, res.body.data.accessToken)).status).toBe(200);
    });

    it('treats an immediate second use as a tab race, not theft', async () => {
      const first = refreshCookieOf(await login(PH, 'owner@powerhouse.demo'))!;
      const second = refreshCookieOf(await refresh(PH, first))!;
      const raced = await refresh(PH, first);
      expect(raced.status).toBe(401);
      expect(raced.body.error.code).toBe('REFRESH_RACE');
      expect((await refresh(PH, second)).status).toBe(200);
    });

    it('revokes the whole session when an old refresh token is replayed later (theft)', async () => {
      const loginRes = await login(PH, 'owner@powerhouse.demo');
      const access = loginRes.body.data.accessToken;
      const stolen = refreshCookieOf(loginRes)!;
      const current = refreshCookieOf(await refresh(PH, stolen))!;
      await asGym('powerhouse', () =>
        Session.updateMany({}, { rotatedAt: new Date(Date.now() - 60_000) }),
      );

      const replay = await refresh(PH, stolen);
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('INVALID_REFRESH');
      // Both the legitimate holder and the access token are now dead.
      expect((await refresh(PH, current)).status).toBe(401);
      expect((await me(PH, access)).status).toBe(401);
    });

    it("CROSS-TENANT: Gym A's refresh token does nothing on Gym B's host", async () => {
      const cookie = refreshCookieOf(await login(PH, 'owner@powerhouse.demo'))!;
      expect((await refresh(FZ, cookie)).status).toBe(401);
      expect((await refresh(PH, cookie)).status).toBe(200); // and was not burned by the attempt
    });

    it('rejects refresh requests coming from another origin', async () => {
      const cookie = refreshCookieOf(await login(PH, 'owner@powerhouse.demo'))!;
      const fromOtherGym = await refresh(PH, cookie).set('Origin', 'http://fitzone.localhost:3000');
      expect(fromOtherGym.status).toBe(403);
      expect(fromOtherGym.body.error.code).toBe('CROSS_ORIGIN_REJECTED');
      expect((await refresh(PH, cookie).set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
      expect(
        (await refresh(PH, cookie).set('Origin', 'http://powerhouse.localhost:3000')).status,
      ).toBe(200);
    });

    it('logout ends the session immediately, for both tokens', async () => {
      const res = await login(PH, 'owner@powerhouse.demo');
      const access = res.body.data.accessToken;
      const cookie = refreshCookieOf(res)!;
      const out = await request(app)
        .post('/api/v1/auth/logout')
        .set('Host', PH)
        .set('Cookie', `${COOKIE}=${cookie}`);
      expect(out.status).toBe(204);
      expect((out.headers['set-cookie'] as unknown as string[]).join()).toMatch(/gym_rt=;/);
      expect((await me(PH, access)).status).toBe(401);
      expect((await refresh(PH, cookie)).status).toBe(401);
    });

    it('logout-all ends every device', async () => {
      const a = (await login(PH, 'owner@powerhouse.demo')).body.data.accessToken;
      const b = (await login(PH, 'owner@powerhouse.demo')).body.data.accessToken;
      await request(app)
        .post('/api/v1/auth/logout-all')
        .set('Host', PH)
        .set('Authorization', `Bearer ${a}`)
        .expect(204);
      expect((await me(PH, a)).status).toBe(401);
      expect((await me(PH, b)).status).toBe(401);
    });

    it('logout { everywhere } with the refresh cookie alone ends every device (sign-out tapped offline)', async () => {
      const first = await login(PH, 'owner@powerhouse.demo');
      const cookie = refreshCookieOf(first)!;
      const other = await login(PH, 'owner@powerhouse.demo');
      await request(app)
        .post('/api/v1/auth/logout')
        .set('Host', PH)
        .set('Cookie', `${COOKIE}=${cookie}`)
        .send({ everywhere: true })
        .expect(204);
      expect((await me(PH, first.body.data.accessToken)).status).toBe(401);
      expect((await me(PH, other.body.data.accessToken)).status).toBe(401);
      expect((await refresh(PH, refreshCookieOf(other)!)).status).toBe(401);
    });

    it('logout { everywhere } with a cookie that is already signed out ends nothing else', async () => {
      const first = await login(PH, 'owner@powerhouse.demo');
      const cookie = refreshCookieOf(first)!;
      const other = await login(PH, 'owner@powerhouse.demo');
      const out = () =>
        request(app)
          .post('/api/v1/auth/logout')
          .set('Host', PH)
          .set('Cookie', `${COOKIE}=${cookie}`);
      await out().expect(204);
      await out().send({ everywhere: true }).expect(204);
      expect((await me(PH, other.body.data.accessToken)).status).toBe(200);
    });

    it('lists my sessions and lets me end one, but never someone else’s (IDOR)', async () => {
      const mine = (await login(PH, 'owner@powerhouse.demo')).body.data.accessToken;
      await login(PH, 'owner@powerhouse.demo');
      const staffToken = (await login(PH, 'desk@powerhouse.demo')).body.data.accessToken;

      const list = await request(app)
        .get('/api/v1/auth/sessions')
        .set('Host', PH)
        .set('Authorization', `Bearer ${mine}`);
      expect(list.body.data).toHaveLength(2);
      expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      const other = list.body.data.find((s: { current: boolean }) => !s.current).id;

      const hijack = await request(app)
        .delete(`/api/v1/auth/sessions/${other}`)
        .set('Host', PH)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(hijack.status).toBe(404);

      await request(app)
        .delete(`/api/v1/auth/sessions/${other}`)
        .set('Host', PH)
        .set('Authorization', `Bearer ${mine}`)
        .expect(204);
      const after = await request(app)
        .get('/api/v1/auth/sessions')
        .set('Host', PH)
        .set('Authorization', `Bearer ${mine}`);
      expect(after.body.data).toHaveLength(1);
    });
  });

  // ============================================================ member email link
  describeWithDb('session role for the web server (GET /auth/session)', () => {
    const peek = (host: string, cookie?: string) => {
      const r = request(app).get('/api/v1/auth/session').set('Host', host);
      return cookie ? r.set('Cookie', `${COOKIE}=${cookie}`) : r;
    };

    it('reports the role behind the cookie without rotating it', async () => {
      const owner = refreshCookieOf(await login(PH, 'owner@powerhouse.demo'))!;
      const staff = refreshCookieOf(await login(PH, '98000 00002'))!;
      const admin = refreshCookieOf(await login(PLATFORM, 'admin@platform.demo'))!;

      const res = await peek(PH, owner);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ scope: 'tenant', role: 'owner' });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect((await peek(PH, staff)).body.data).toEqual({ scope: 'tenant', role: 'staff' });
      expect((await peek(PLATFORM, admin)).body.data).toEqual({
        scope: 'platform',
        role: 'super_admin',
      });
      // Not used up: the same cookie still refreshes.
      expect((await refresh(PH, owner)).status).toBe(200);
    });

    it('a cookie rotated a moment ago still counts; a dead or foreign one does not', async () => {
      const first = refreshCookieOf(await login(PH, 'owner@powerhouse.demo'))!;
      const second = refreshCookieOf(await refresh(PH, first))!;
      expect((await peek(PH, first)).body.data).toEqual({ scope: 'tenant', role: 'owner' });
      expect((await peek(PH, second)).status).toBe(200);

      expect((await peek(PH)).status).toBe(401);
      expect((await peek(PH, 'not-a-token')).status).toBe(401);
      expect((await peek(FZ, second)).status).toBe(401); // another gym's host
      expect((await peek(PLATFORM, second)).status).toBe(401);

      await request(app)
        .post('/api/v1/auth/logout')
        .set('Host', PH)
        .set('Cookie', `${COOKIE}=${second}`);
      expect((await peek(PH, second)).status).toBe(401);
    });
  });

  describeWithDb('member sign-in by email link', () => {
    const requestLink = (host: string, email: string) =>
      request(app).post('/api/v1/auth/magic-link').set('Host', host).send({ email });
    const verify = (host: string, token: string) =>
      request(app).post('/api/v1/auth/magic-link/verify').set('Host', host).send({ token });

    it("emails a link to the gym's own app and signs the member in", async () => {
      const res = await requestLink(PH, 'Arjun@Member.demo');
      expect(res.status).toBe(202);
      expect(mailer.outbox).toHaveLength(1);
      const mail = mailer.outbox[0]!;
      // White-label: the member sees their gym as the sender, never the platform.
      expect(mail).toMatchObject({
        to: 'arjun@member.demo',
        kind: 'magic_link',
        fromName: 'Powerhouse Fitness',
      });
      expect(mail.subject).toContain('Powerhouse Fitness');
      expect(JSON.stringify(mail)).not.toMatch(/fitexaa/i);
      expect(mail.text).toContain('http://powerhouse.localhost:3000/login/verify?token=');

      const signedIn = await verify(PH, lastLinkToken());
      expect(signedIn.status).toBe(200);
      expect(signedIn.body.data.user).toMatchObject({
        role: 'member',
        permissions: ['self:read', 'self:update', 'self:pay'],
      });
      expect(refreshCookieOf(signedIn)).toBeTruthy();
    });

    it('stores only a hash of the link token', async () => {
      await requestLink(PH, 'arjun@member.demo');
      const token = lastLinkToken();
      const stored = await asGym('powerhouse', () => AuthToken.findOne().lean());
      expect(stored!.tokenHash).not.toBe(token);
      expect(JSON.stringify(stored)).not.toContain(token);
    });

    it('a link works exactly once', async () => {
      await requestLink(PH, 'arjun@member.demo');
      const token = lastLinkToken();
      expect((await verify(PH, token)).status).toBe(200);
      const again = await verify(PH, token);
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('INVALID_LINK');
    });

    it('two simultaneous clicks produce exactly one session', async () => {
      await requestLink(PH, 'arjun@member.demo');
      const token = lastLinkToken();
      const results = await Promise.all([verify(PH, token), verify(PH, token), verify(PH, token)]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    });

    it('expired links are refused', async () => {
      await requestLink(PH, 'arjun@member.demo');
      await asGym('powerhouse', () =>
        AuthToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) }),
      );
      expect((await verify(PH, lastLinkToken())).body.error.code).toBe('INVALID_LINK');
    });

    it("CROSS-TENANT: Gym A's link can't sign in at Gym B, even for the same person", async () => {
      // Arjun is a member of BOTH gyms with the same email.
      await requestLink(PH, 'arjun@member.demo');
      const res = await verify(FZ, lastLinkToken());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_LINK');
    });

    it('reveals nothing about who is a member', async () => {
      const unknown = await requestLink(PH, 'nobody@nowhere.demo');
      const staff = await requestLink(PH, 'desk@powerhouse.demo');
      const otherGymOnly = await requestLink(PH, 'meera@member.demo'); // FitZone member
      for (const r of [unknown, staff, otherGymOnly]) {
        expect(r.status).toBe(202);
        expect(r.body).toEqual((await requestLink(PH, 'arjun@member.demo')).body);
      }
      expect(mailer.outbox.every((m) => m.to === 'arjun@member.demo')).toBe(true);
    });

    it('sends at most 3 links per member per 15 minutes', async () => {
      for (let i = 0; i < 5; i++)
        expect((await requestLink(PH, 'priya@member.demo')).status).toBe(202);
      expect(mailer.outbox).toHaveLength(3);
    });

    it('archived or disabled members cannot sign in with a link already sent', async () => {
      await requestLink(PH, 'arjun@member.demo');
      await asGym('powerhouse', () =>
        User.updateOne({ email: 'arjun@member.demo' }, { status: 'disabled' }),
      );
      expect((await verify(PH, lastLinkToken())).status).toBe(400);
    });

    it('rejects garbage tokens without touching the database', async () => {
      expect((await verify(PH, "' OR 1=1 --")).body.error.code).toBe('INVALID_LINK');
      expect((await verify(PH, 'a'.repeat(43))).body.error.code).toBe('INVALID_LINK');
    });

    it('members have no password to change', async () => {
      await requestLink(PH, 'arjun@member.demo');
      const { accessToken } = (await verify(PH, lastLinkToken())).body.data;
      const res = await request(app)
        .post('/api/v1/auth/password/change')
        .set('Host', PH)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'x', newPassword: 'something-long' });
      expect(res.status).toBe(403);
    });

    it('is not offered on the platform host', async () => {
      const res = await requestLink(PLATFORM, 'arjun@member.demo');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TENANT_REQUIRED');
    });
  });

  // ============================================================ passwords
  describeWithDb('forgot, reset and change password', () => {
    const forgot = (host: string, email: string) =>
      request(app).post('/api/v1/auth/password/forgot').set('Host', host).send({ email });
    const reset = (host: string, token: string, password: string) =>
      request(app).post('/api/v1/auth/password/reset').set('Host', host).send({ token, password });

    it('resets the password, signs out every device, and the link dies', async () => {
      const oldAccess = (await login(PH, 'owner@powerhouse.demo')).body.data.accessToken;
      expect((await forgot(PH, 'owner@powerhouse.demo')).status).toBe(202);
      expect(mailer.outbox.at(-1)).toMatchObject({
        kind: 'password_reset',
        to: 'owner@powerhouse.demo',
        fromName: 'Powerhouse Fitness',
      });
      const token = lastLinkToken();

      expect((await reset(PH, token, 'brand-new-password')).status).toBe(204);
      expect((await me(PH, oldAccess)).status).toBe(401);
      expect((await login(PH, 'owner@powerhouse.demo')).status).toBe(401);
      expect((await login(PH, 'owner@powerhouse.demo', 'brand-new-password')).status).toBe(200);
      expect((await reset(PH, token, 'another-password')).body.error.code).toBe('INVALID_LINK');
    });

    it('a reset also clears a lockout', async () => {
      for (let i = 0; i < 5; i++) await login(PH, 'desk@powerhouse.demo', 'wrong-password');
      await forgot(PH, 'desk@powerhouse.demo');
      await reset(PH, lastLinkToken(), 'brand-new-password').expect(204);
      expect((await login(PH, 'desk@powerhouse.demo', 'brand-new-password')).status).toBe(200);
    });

    it("CROSS-TENANT: Gym A's reset link is useless on Gym B", async () => {
      await forgot(PH, 'owner@powerhouse.demo');
      expect((await reset(FZ, lastLinkToken(), 'brand-new-password')).body.error.code).toBe(
        'INVALID_LINK',
      );
    });

    it('does not send reset emails to members or unknown addresses', async () => {
      await forgot(PH, 'arjun@member.demo').expect(202);
      await forgot(PH, 'nobody@nowhere.demo').expect(202);
      expect(mailer.outbox).toHaveLength(0);
    });

    it('enforces a minimum password length', async () => {
      await forgot(PH, 'owner@powerhouse.demo');
      expect((await reset(PH, lastLinkToken(), 'short')).status).toBe(422);
    });

    it('change password needs the current one and keeps only this device signed in', async () => {
      const here = (await login(PH, 'owner@powerhouse.demo')).body.data.accessToken;
      const elsewhere = (await login(PH, 'owner@powerhouse.demo')).body.data.accessToken;
      const change = (current: string) =>
        request(app)
          .post('/api/v1/auth/password/change')
          .set('Host', PH)
          .set('Authorization', `Bearer ${here}`)
          .send({ currentPassword: current, newPassword: 'brand-new-password' });

      expect((await change('wrong-password')).status).toBe(401);
      expect((await change(PASSWORD)).status).toBe(204);
      expect((await me(PH, here)).status).toBe(200);
      expect((await me(PH, elsewhere)).status).toBe(401);
    });
  });

  // ============================================================ seed
  describeWithDb('demo seed', () => {
    it('is idempotent and never overwrites existing gyms', async () => {
      const again = await seedDemo({ password: 'a-different-password' });
      expect(again.admin.created).toBe(false);
      expect(again.gyms.every((g) => !g.created)).toBe(true);
      expect((await login(PH, 'owner@powerhouse.demo')).status).toBe(200);
    });

    it('creates the same member phone in two gyms (unique per gym, not globally)', async () => {
      const counts = await runAsPlatform('test: cross-gym check', () =>
        User.countDocuments({ phone: '+919811111111' }),
      );
      expect(counts).toBe(2);
    });

    it('refuses to run in production', async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expect(seedDemo()).rejects.toThrow(/production/);
      } finally {
        process.env.NODE_ENV = prev;
      }
    });
  });
});
