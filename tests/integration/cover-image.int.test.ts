import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cloudinaryImageStore, type StoredImage } from '../../src/lib/image-store.js';
import { createLogger } from '../../src/lib/logger.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, PLATFORM, gymId, intApp, resetDemo } from '../helpers/int.js';

/**
 * Cover images (member-app hero): only an image we stored for this gym, PNG/JPG/WebP, ≤ 5 MB, any
 * shape, checked against Cloudinary's record of the file. Real signing code; Cloudinary is faked.
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

const JPG_WIDE: StoredImage = { format: 'jpg', bytes: 900_000, width: 1920, height: 1080 };

describeWithDb('gym cover image (real MongoDB, Cloudinary record checked)', () => {
  let owner: string;
  let desk: string;
  let admin: string;
  let ph: string;

  beforeAll(async () => {
    await connectTestDb(`cover_image_${Date.now()}`);
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

  async function uploadCover(file: StoredImage) {
    const s = await call('post', PH, '/uploads/signature', owner).send({ purpose: 'gym_cover' });
    expect(s.status).toBe(200);
    stored[s.body.data.publicId] = file;
    return s.body.data as { publicId: string; deliveryUrl: string; fields: Record<string, string> };
  }
  const setCover = (coverImageUrl: string | null, token = owner) =>
    call('patch', PH, '/gym/branding', token).send({ coverImageUrl });

  it('is null until set, in the gym view and the public branding', async () => {
    expect((await call('get', PH, '/public/tenant')).body.data.branding.coverImageUrl).toBeNull();
    expect((await call('get', PH, '/gym', owner)).body.data.branding.coverImageUrl).toBeNull();
  });

  it('signs raster-only uploads into the gym branding folder, delivered at most 1920 px', async () => {
    const s = await uploadCover(JPG_WIDE);
    expect(s.publicId).toMatch(
      new RegExp(`^fitexaa-test/gyms/${ph}/branding/cover-[A-Za-z0-9]{16}$`),
    );
    expect(s.fields.allowed_formats?.split(',').sort()).toEqual(['jpeg', 'jpg', 'png', 'webp']);
    expect(s.deliveryUrl).toContain('/c_limit,w_1920,h_1920,f_auto,q_auto/');
  });

  it('refuses SVG, GIF and files over 5 MB, using what Cloudinary actually stored', async () => {
    for (const [file, message] of [
      [{ format: 'svg', bytes: 2_000, width: 1600, height: 900 }, 'PNG, JPG or WebP'],
      [{ format: 'gif', bytes: 2_000, width: 1600, height: 900 }, 'PNG, JPG or WebP'],
      [{ format: 'jpg', bytes: 5 * 1024 * 1024 + 1, width: 1600, height: 900 }, '5 MB'],
    ] as const) {
      const { deliveryUrl } = await uploadCover(file);
      const res = await setCover(deliveryUrl);
      expect(res.status, file.format).toBe(422);
      expect(res.body.error.details[0]).toMatchObject({ path: 'coverImageUrl' });
      expect(res.body.error.details[0].message).toContain(message);
    }
    expect((await call('get', PH, '/public/tenant')).body.data.branding.coverImageUrl).toBeNull();
  });

  it('accepts exactly 5 MB and any shape (wide or tall)', async () => {
    for (const file of [
      { format: 'png', bytes: 5 * 1024 * 1024, width: 3000, height: 1000 },
      { format: 'webp', bytes: 400_000, width: 1080, height: 1920 },
    ] as const) {
      const { deliveryUrl } = await uploadCover(file);
      expect((await setCover(deliveryUrl)).status, file.format).toBe(200);
    }
  });

  it('refuses links that are not our cover upload for this gym', async () => {
    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    const fz = await call('post', FZ, '/uploads/signature', fzOwner).send({ purpose: 'gym_cover' });
    stored[fz.body.data.publicId] = JPG_WIDE;
    const icon = await call('post', PH, '/uploads/signature', owner).send({ purpose: 'gym_icon' });
    stored[icon.body.data.publicId] = JPG_WIDE;
    for (const url of [
      'https://images.example/gym.jpg',
      fz.body.data.deliveryUrl, // FitZone's cover
      icon.body.data.deliveryUrl, // an icon upload, not a cover
    ]) {
      expect((await setCover(url)).status, url).toBe(422);
    }
    const ghost = await call('post', PH, '/uploads/signature', owner).send({
      purpose: 'gym_cover',
    });
    expect((await setCover(ghost.body.data.deliveryUrl)).status).toBe(422);
  });

  it('shows in public branding; replacing deletes the old cover; null clears it; the icon is untouched', async () => {
    const first = await uploadCover(JPG_WIDE);
    const res = await setCover(first.deliveryUrl);
    expect(res.status).toBe(200);
    expect(res.body.data.branding.coverImageUrl).toBe(first.deliveryUrl);
    const pub = (await call('get', PH, '/public/tenant')).body.data.branding;
    expect(pub.coverImageUrl).toBe(first.deliveryUrl);
    expect(pub.updatedAt).toBe(res.body.data.branding.updatedAt);

    const second = await uploadCover({ format: 'webp', bytes: 300_000, width: 1600, height: 900 });
    expect((await setCover(second.deliveryUrl)).status).toBe(200);
    expect(destroyed).toEqual([first.publicId]);

    const cleared = await setCover(null);
    expect(cleared.body.data.branding.coverImageUrl).toBeNull();
    expect(destroyed).toEqual([first.publicId, second.publicId]);
    expect(cleared.body.data.branding.appIconUrl).toBeNull();
  });

  it('only owners and super admins can change it: staff get 403', async () => {
    const { deliveryUrl } = await uploadCover(JPG_WIDE);
    expect((await setCover(deliveryUrl, desk)).status).toBe(403);
    expect(
      (await call('post', PH, '/uploads/signature', desk).send({ purpose: 'gym_cover' })).status,
    ).toBe(403);
  });

  it('super admin signs a cover upload for the gym and sets it, with the same checks', async () => {
    const sig = await call(
      'post',
      PLATFORM,
      `/platform/tenants/${ph}/uploads/signature`,
      admin,
    ).send({ purpose: 'gym_cover' });
    expect(sig.status).toBe(200);
    expect(sig.body.data.publicId).toMatch(
      new RegExp(`^fitexaa-test/gyms/${ph}/branding/cover-[A-Za-z0-9]{16}$`),
    );
    const patch = () =>
      call('patch', PLATFORM, `/platform/tenants/${ph}/branding`, admin).send({
        coverImageUrl: sig.body.data.deliveryUrl,
      });

    stored[sig.body.data.publicId] = { format: 'svg', bytes: 1_000, width: 1600, height: 900 };
    expect((await patch()).status).toBe(422);

    stored[sig.body.data.publicId] = JPG_WIDE;
    const good = await patch();
    expect(good.status).toBe(200);
    expect(good.body.data.branding.coverImageUrl).toBe(sig.body.data.deliveryUrl);
  });
});
