import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AuditLog, Member } from '../../src/db/models.js';
import { cloudinaryImageStore } from '../../src/lib/image-store.js';
import { createLogger } from '../../src/lib/logger.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

// Real signing code; only the network call to Cloudinary (destroy) is faked.
const cloudinary = vi.fn(async () => new Response(JSON.stringify({ result: 'ok' })));
const images = cloudinaryImageStore({
  cloudName: 'demo-cloud',
  apiKey: '123456789012',
  apiSecret: 'test-secret-value',
  folder: 'gym-saas-test',
  logger: createLogger('silent'),
  fetch: cloudinary as unknown as typeof fetch,
});
const { mailer, call, tokenFor, memberToken } = intApp({}, images);
const unconfigured = intApp({}, null);

async function memberIdOf(slug: string, phone: string) {
  return runInTenant(await gymId(slug), async () =>
    String((await Member.findOne({ phone }).lean())!._id),
  );
}
const destroyedIds = () =>
  cloudinary.mock.calls.map((c) =>
    new URLSearchParams((c as unknown as [string, RequestInit])[1].body as URLSearchParams).get(
      'public_id',
    ),
  );

describeWithDb('image uploads (real MongoDB, Cloudinary signing)', () => {
  let owner: string;
  let desk: string;
  let ph: string;
  let priya: string;

  beforeAll(async () => {
    await connectTestDb(`uploads_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    cloudinary.mockClear();
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
    ph = await gymId('powerhouse');
    priya = await memberIdOf('powerhouse', '+919811111112');
  });

  const sign = (token: string, body: object, host = PH) =>
    call('post', host, '/uploads/signature', token).send(body);

  it("signs a member photo under this gym's folder; front desk sets it; replacing deletes the old one", async () => {
    const s1 = await sign(desk, { purpose: 'member_photo', memberId: priya });
    expect(s1.status).toBe(200);
    const id1 = s1.body.data.publicId as string;
    expect(id1).toMatch(new RegExp(`^gym-saas-test/gyms/${ph}/members/${priya}/[A-Za-z0-9]{16}$`));
    expect(s1.body.data.fields.signature).toMatch(/^[a-f0-9]{40}$/);
    expect(JSON.stringify(s1.body)).not.toContain('test-secret-value');

    const set1 = await call('put', PH, `/members/${priya}/photo`, desk).send({ publicId: id1 });
    expect(set1.status).toBe(200);
    expect(set1.body.data.photoUrl).toBe(s1.body.data.deliveryUrl);
    expect(cloudinary).not.toHaveBeenCalled();

    const id2 = (await sign(desk, { purpose: 'member_photo', memberId: priya })).body.data.publicId;
    expect(id2).not.toBe(id1);
    await call('put', PH, `/members/${priya}/photo`, desk).send({ publicId: id2 });
    expect(destroyedIds()).toEqual([id1]);

    const removed = await call('delete', PH, `/members/${priya}/photo`, desk);
    expect(removed.body.data.photoUrl).toBeNull();
    expect(destroyedIds()).toEqual([id1, id2]);

    const actions = await runInTenant(ph, () =>
      AuditLog.find({ action: /^member\.photo/ }).distinct('action'),
    );
    expect(actions.sort()).toEqual(['member.photo_remove', 'member.photo_update']);
  });

  it('owner signs logo and icon uploads; the URL goes into branding', async () => {
    const s = await sign(owner, { purpose: 'gym_logo' });
    expect(s.status).toBe(200);
    expect(s.body.data.publicId).toMatch(new RegExp(`^gym-saas-test/gyms/${ph}/branding/logo-`));
    const b = await call('patch', PH, '/gym/branding', owner).send({
      logoUrl: s.body.data.deliveryUrl,
    });
    expect(b.body.data.branding.logoUrl).toBe(s.body.data.deliveryUrl);
    expect((await sign(owner, { purpose: 'gym_icon' })).status).toBe(200);
  });

  it('422 for ids this member was never issued: other member, other gym, traversal, junk', async () => {
    const arjun = await memberIdOf('powerhouse', '+919811111111');
    const fz = await gymId('fitzone');
    for (const publicId of [
      `gym-saas-test/gyms/${ph}/members/${arjun}/abcdefgh12345678`,
      `gym-saas-test/gyms/${fz}/members/${priya}/abcdefgh12345678`,
      `gym-saas-test/gyms/${ph}/members/${priya}/../${arjun}/abcdefgh1234`,
      `gym-saas-test/gyms/${ph}/members/${priya}/short`,
      `gym-saas-test/gyms/${ph}/branding/logo-abcdefgh12345678`,
      'https://evil.example/x.png',
    ]) {
      const res = await call('put', PH, `/members/${priya}/photo`, desk).send({ publicId });
      expect(res.status, publicId).toBe(422);
    }
    expect((await sign(desk, { purpose: 'member_photo', memberId: 'nope' })).status).toBe(422);
    expect((await sign(desk, { purpose: 'avatar' })).status).toBe(422);
  });

  it('authorization: staff cannot sign branding uploads; members cannot sign anything', async () => {
    expect((await sign(desk, { purpose: 'gym_logo' })).status).toBe(403);
    const arjun = await memberToken(PH, 'arjun@member.demo');
    expect((await sign(arjun, { purpose: 'member_photo', memberId: priya })).status).toBe(403);
    expect((await sign(arjun, { purpose: 'gym_logo' })).status).toBe(403);
    expect(
      (await call('put', PH, `/members/${priya}/photo`, arjun).send({ publicId: 'x' })).status,
    ).toBe(403);
    expect(
      (await call('post', PH, '/uploads/signature').send({ purpose: 'gym_logo' })).status,
    ).toBe(401);
  });

  it('cross-tenant: FitZone cannot sign for or set a Powerhouse member photo', async () => {
    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    expect((await sign(fzOwner, { purpose: 'member_photo', memberId: priya }, FZ)).status).toBe(
      404,
    );
    const phId = (await sign(desk, { purpose: 'member_photo', memberId: priya })).body.data
      .publicId;
    expect(
      (await call('put', FZ, `/members/${priya}/photo`, fzOwner).send({ publicId: phId })).status,
    ).toBe(404);
    expect((await call('delete', FZ, `/members/${priya}/photo`, fzOwner)).status).toBe(404);
    // A FitZone logo signature lands in FitZone's folder, never Powerhouse's.
    const fzLogo = await sign(fzOwner, { purpose: 'gym_logo' }, FZ);
    expect(fzLogo.body.data.publicId).toContain(`/gyms/${await gymId('fitzone')}/`);
  });

  it('archived members: no signing, no photo changes', async () => {
    await call('post', PH, `/members/${priya}/archive`, owner);
    expect((await sign(desk, { purpose: 'member_photo', memberId: priya })).status).toBe(404);
    expect((await call('delete', PH, `/members/${priya}/photo`, desk)).status).toBe(409);
  });

  it('503 UPLOADS_NOT_CONFIGURED without Cloudinary credentials', async () => {
    const t = await unconfigured.tokenFor(PH, 'owner@powerhouse.demo');
    const res = await unconfigured.call('post', PH, '/uploads/signature', t).send({
      purpose: 'gym_logo',
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('UPLOADS_NOT_CONFIGURED');
    expect((await unconfigured.call('delete', PH, `/members/${priya}/photo`, t)).status).toBe(503);
  });
});
