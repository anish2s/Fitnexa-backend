import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cloudinaryImageStore, type StoredImage } from '../../src/lib/image-store.js';
import { createLogger } from '../../src/lib/logger.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, PLATFORM, gymId, intApp, resetDemo } from '../helpers/int.js';

/**
 * App icons: only an image we stored for this gym, and only PNG/JPG/WebP, ≤ 2 MB, square, checked
 * against Cloudinary's record of the file. Real signing code; Cloudinary's network is faked.
 */
let stored: Record<string, StoredImage> = {};
const destroyed: string[] = [];
const cloudinary = vi.fn(async (url: string, init?: RequestInit) => {
  const m = /\/resources\/image\/upload\/(.+)$/.exec(url);
  if (m) {
    const r = stored[m[1]!];
    return r ? new Response(JSON.stringify(r)) : new Response('{}', { status: 404 });
  }
  if (url.endsWith('/destroy'))
    destroyed.push(new URLSearchParams(init!.body as URLSearchParams).get('public_id')!);
  return new Response(JSON.stringify({ result: 'ok' }));
});
const images = cloudinaryImageStore({
  cloudName: 'demo-cloud',
  apiKey: '123456789012',
  apiSecret: 'test-secret-value',
  folder: 'fitexaa-test',
  logger: createLogger('silent'),
  fetch: cloudinary as unknown as typeof fetch,
});
const { mailer, call, tokenFor } = intApp({}, images);

const PNG_512: StoredImage = { format: 'png', bytes: 40_000, width: 512, height: 512 };

describeWithDb('gym app icon (real MongoDB, Cloudinary record checked)', () => {
  let owner: string;
  let desk: string;
  let admin: string;
  let ph: string;

  beforeAll(async () => {
    await connectTestDb(`app_icon_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    stored = {};
    destroyed.length = 0;
    cloudinary.mockClear();
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
    desk = await tokenFor(PH, 'desk@powerhouse.demo');
    admin = await tokenFor(PLATFORM, 'admin@platform.demo');
    ph = await gymId('powerhouse');
  });

  /** Signs an icon upload as the owner and "uploads" a file with the given stored properties. */
  async function uploadIcon(file: StoredImage) {
    const s = await call('post', PH, '/uploads/signature', owner).send({ purpose: 'gym_icon' });
    expect(s.status).toBe(200);
    stored[s.body.data.publicId] = file;
    return s.body.data as { publicId: string; deliveryUrl: string; fields: Record<string, string> };
  }
  const setIcon = (appIconUrl: string | null, token = owner) =>
    call('patch', PH, '/gym/branding', token).send({ appIconUrl });

  it('the upload signature allows raster formats only (no SVG)', async () => {
    const s = await uploadIcon(PNG_512);
    expect((s.fields.allowed_formats ?? '').split(',').sort()).toEqual([
      'jpeg',
      'jpg',
      'png',
      'webp',
    ]);
    expect(s.fields.allowed_formats).not.toContain('svg');
  });

  it('refuses SVG, oversized and non-square icons, using what Cloudinary actually stored', async () => {
    for (const [file, message] of [
      [{ format: 'svg', bytes: 2_000, width: 512, height: 512 }, 'PNG, JPG or WebP'],
      [{ format: 'gif', bytes: 2_000, width: 512, height: 512 }, 'PNG, JPG or WebP'],
      [{ format: 'png', bytes: 2 * 1024 * 1024 + 1, width: 512, height: 512 }, '2 MB'],
      [{ format: 'webp', bytes: 30_000, width: 600, height: 400 }, 'square'],
    ] as const) {
      const { deliveryUrl } = await uploadIcon(file);
      const res = await setIcon(deliveryUrl);
      expect(res.status, file.format).toBe(422);
      expect(res.body.error.details[0]).toMatchObject({ path: 'appIconUrl' });
      expect(res.body.error.details[0].message).toContain(message);
    }
    const view = await call('get', PH, '/public/tenant');
    expect(view.body.data.branding.appIconUrl).toBeNull();
  });

  it('refuses links that are not our upload for this gym', async () => {
    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    const fz = await call('post', FZ, '/uploads/signature', fzOwner).send({ purpose: 'gym_icon' });
    stored[fz.body.data.publicId] = PNG_512;
    const logo = await call('post', PH, '/uploads/signature', owner).send({ purpose: 'gym_logo' });
    for (const url of [
      'https://evil.example/icon.png',
      'https://example.com/icon.svg',
      fz.body.data.deliveryUrl, // FitZone's icon
      logo.body.data.deliveryUrl, // a logo, not an icon
      `${images.deliveryUrl(`fitexaa-test/gyms/${ph}/branding/icon-abcdefgh12345678`, 'icon')}?x=1`,
    ]) {
      expect((await setIcon(url)).status, url).toBe(422);
    }
    // Signed but never uploaded: not found at Cloudinary.
    const ghost = await call('post', PH, '/uploads/signature', owner).send({ purpose: 'gym_icon' });
    expect((await setIcon(ghost.body.data.deliveryUrl)).status).toBe(422);
  });

  it('accepts a square PNG; versions branding; replacing deletes the old icon; null clears it', async () => {
    const before = (await call('get', PH, '/public/tenant')).body.data.branding.updatedAt;
    const first = await uploadIcon(PNG_512);
    const res = await setIcon(first.deliveryUrl);
    expect(res.status).toBe(200);
    expect(res.body.data.branding.appIconUrl).toBe(first.deliveryUrl);
    const v1 = res.body.data.branding.updatedAt as string;
    expect(v1).toBeTruthy();
    expect(v1).not.toBe(before);

    const pub = (await call('get', PH, '/public/tenant')).body.data.branding;
    expect(pub).toMatchObject({ appIconUrl: first.deliveryUrl, updatedAt: v1 });

    const second = await uploadIcon({ format: 'jpg', bytes: 90_000, width: 1024, height: 1024 });
    const res2 = await setIcon(second.deliveryUrl);
    expect(res2.status).toBe(200);
    expect(new Date(res2.body.data.branding.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(v1).getTime(),
    );
    expect(destroyed).toEqual([first.publicId]);

    const cleared = await setIcon(null);
    expect(cleared.body.data.branding.appIconUrl).toBeNull();
    expect(destroyed).toEqual([first.publicId, second.publicId]);
  });

  it('only owners and super admins can change it: staff get 403', async () => {
    const { deliveryUrl } = await uploadIcon(PNG_512);
    expect((await setIcon(deliveryUrl, desk)).status).toBe(403);
    expect(
      (await call('post', PH, '/uploads/signature', desk).send({ purpose: 'gym_icon' })).status,
    ).toBe(403);
    expect((await call('get', PH, '/public/tenant')).body.data.branding.appIconUrl).toBeNull();
  });

  it('super admin signs an icon upload for the gym and sets it, with the same checks', async () => {
    const sig = await call(
      'post',
      PLATFORM,
      `/platform/tenants/${ph}/uploads/signature`,
      admin,
    ).send({ purpose: 'gym_icon' });
    expect(sig.status).toBe(200);
    expect(sig.body.data.publicId).toMatch(
      new RegExp(`^fitexaa-test/gyms/${ph}/branding/icon-[A-Za-z0-9]{16}$`),
    );

    stored[sig.body.data.publicId] = { format: 'svg', bytes: 1_000, width: 64, height: 64 };
    const bad = await call('patch', PLATFORM, `/platform/tenants/${ph}/branding`, admin).send({
      appIconUrl: sig.body.data.deliveryUrl,
    });
    expect(bad.status).toBe(422);

    stored[sig.body.data.publicId] = PNG_512;
    const good = await call('patch', PLATFORM, `/platform/tenants/${ph}/branding`, admin).send({
      appIconUrl: sig.body.data.deliveryUrl,
    });
    expect(good.status).toBe(200);
    expect(good.body.data.branding.appIconUrl).toBe(sig.body.data.deliveryUrl);

    // The platform route is for super admins only, and only on the platform host.
    expect(
      (
        await call('post', PLATFORM, `/platform/tenants/${ph}/uploads/signature`, owner).send({
          purpose: 'gym_icon',
        })
      ).status,
    ).toBeGreaterThanOrEqual(401);
    expect(
      (
        await call('post', PH, `/platform/tenants/${ph}/uploads/signature`, owner).send({
          purpose: 'gym_icon',
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await call('post', PLATFORM, `/platform/tenants/${ph}/uploads/signature`, admin).send({
          purpose: 'member_photo',
        })
      ).status,
    ).toBe(422);
  });
});
