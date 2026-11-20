import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import {
  cloudinaryImageStore,
  cloudinarySignature,
  createImageStore,
  randomImageName,
} from '../../src/lib/image-store.js';
import { createLogger } from '../../src/lib/logger.js';

const logger = createLogger('silent');
const NOW = new Date('2026-11-17T10:00:00Z');

function store(fetchImpl?: typeof fetch) {
  return cloudinaryImageStore({
    cloudName: 'demo-cloud',
    apiKey: '123456789012',
    apiSecret: 'shhh-secret-value',
    folder: 'fitexaa-test',
    logger,
    fetch: fetchImpl,
    now: () => NOW,
  });
}

describe('cloudinary signing', () => {
  it("matches Cloudinary's documented example", () => {
    expect(
      cloudinarySignature(
        {
          eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop',
          public_id: 'sample_image',
          timestamp: '1315060510',
        },
        'abcd',
      ),
    ).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  it('signs the exact public id, formats and no-overwrite; the secret never leaves', () => {
    const s = store().signUpload(
      'fitexaa-test/gyms/g1/members/m1/abcdefgh12345678',
      'member_photo',
    );
    expect(s.uploadUrl).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/upload');
    expect(s.fields).toMatchObject({
      api_key: '123456789012',
      public_id: 'fitexaa-test/gyms/g1/members/m1/abcdefgh12345678',
      allowed_formats: 'jpg,jpeg,png,webp',
      overwrite: 'false',
      timestamp: String(NOW.getTime() / 1000),
    });
    const signed = Object.fromEntries(
      Object.entries(s.fields).filter(([k]) => k !== 'api_key' && k !== 'signature'),
    );
    expect(s.fields.signature).toBe(cloudinarySignature(signed, 'shhh-secret-value'));
    expect(JSON.stringify(s)).not.toContain('shhh-secret-value');
    expect(s.deliveryUrl).toBe(
      'https://res.cloudinary.com/demo-cloud/image/upload/c_fill,g_face,w_400,h_400,f_auto,q_auto/fitexaa-test/gyms/g1/members/m1/abcdefgh12345678',
    );
    expect(s.expiresAt.getTime() - NOW.getTime()).toBe(3_600_000);
  });

  it('random names are 16 alphanumerics', () => {
    for (let i = 0; i < 50; i++) expect(randomImageName()).toMatch(/^[A-Za-z0-9]{16}$/);
  });
});

describe('cloudinary destroy', () => {
  it('posts a signed destroy request', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ result: 'ok' })));
    await store(f as unknown as typeof fetch).destroy('fitexaa-test/gyms/g1/x');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/destroy');
    const form = new URLSearchParams(init.body as URLSearchParams);
    expect(form.get('public_id')).toBe('fitexaa-test/gyms/g1/x');
    expect(form.get('signature')).toBe(
      cloudinarySignature(
        {
          invalidate: 'true',
          public_id: 'fitexaa-test/gyms/g1/x',
          timestamp: form.get('timestamp')!,
        },
        'shhh-secret-value',
      ),
    );
  });

  it('never throws, whatever Cloudinary does', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const refused = vi.fn(async () => new Response('{}', { status: 401 }));
    await expect(store(down as unknown as typeof fetch).destroy('x')).resolves.toBeUndefined();
    await expect(store(refused as unknown as typeof fetch).destroy('x')).resolves.toBeUndefined();
  });
});

describe('cloudinary server API address (tests point it at a local mock)', () => {
  it('server calls go to CLOUDINARY_API_URL; browser uploads always go to the public API', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ result: 'ok', format: 'PNG', bytes: 9, width: 2, height: 2 }),
        ),
    );
    const s = cloudinaryImageStore({
      cloudName: 'e2e-mock',
      apiKey: '123456',
      apiSecret: 'e2e-mock-secret-not-real',
      folder: 'fitexaa-e2e',
      apiUrl: 'http://127.0.0.1:4180/',
      logger,
      fetch: f as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(s.signUpload('fitexaa-e2e/gyms/g1/branding/icon-x', 'icon').uploadUrl).toBe(
      'https://api.cloudinary.com/v1_1/e2e-mock/image/upload',
    );
    expect(await s.inspect('fitexaa-e2e/gyms/g1/branding/icon-x')).toEqual({
      format: 'png',
      bytes: 9,
      width: 2,
      height: 2,
    });
    await s.destroy('fitexaa-e2e/gyms/g1/branding/icon-x');
    const urls = f.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls).toEqual([
      'http://127.0.0.1:4180/v1_1/e2e-mock/resources/image/upload/fitexaa-e2e/gyms/g1/branding/icon-x',
      'http://127.0.0.1:4180/v1_1/e2e-mock/image/destroy',
    ]);
  });

  it('defaults to the real API and production refuses anything else', () => {
    const base = {
      MONGODB_URI: 'mongodb://x/y',
      BASE_DOMAINS: 'yourapp.in',
      JWT_ACCESS_SECRET: 'x'.repeat(48),
    };
    expect(parseEnv(base).CLOUDINARY_API_URL).toBe('https://api.cloudinary.com');
    expect(
      parseEnv({ ...base, CLOUDINARY_API_URL: 'http://127.0.0.1:4180/' }).CLOUDINARY_API_URL,
    ).toBe('http://127.0.0.1:4180');
    const prod = {
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://*.yourapp.in',
      GYM_APP_URL_TEMPLATE: 'https://{slug}.yourapp.in',
      MAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 're_test_12345678',
      MAIL_FROM: 'Gym <no-reply@yourapp.in>',
      TRUST_PROXY: 'uniquelocal',
    };
    expect(parseEnv(prod).CLOUDINARY_API_URL).toBe('https://api.cloudinary.com');
    expect(() => parseEnv({ ...prod, CLOUDINARY_API_URL: 'http://127.0.0.1:4180' })).toThrow(
      /CLOUDINARY_API_URL/,
    );
  });
});

describe('cloudinary config', () => {
  const base = {
    MONGODB_URI: 'mongodb://x/y',
    BASE_DOMAINS: 'yourapp.in',
    JWT_ACCESS_SECRET: 'x'.repeat(48),
  };

  it('rejects a truncated API secret at startup', () => {
    expect(() =>
      parseEnv({
        ...base,
        CLOUDINARY_CLOUD_NAME: 'demo',
        CLOUDINARY_API_KEY: '123456789012',
        CLOUDINARY_API_SECRET: 'abcdefghij',
      }),
    ).toThrow(/Invalid Cloudinary API secret/);
  });

  it('is optional, but all three values go together', () => {
    expect(createImageStore(parseEnv(base), logger)).toBeNull();
    expect(() => parseEnv({ ...base, CLOUDINARY_CLOUD_NAME: 'demo' })).toThrow(/together/);
    const env = parseEnv({
      ...base,
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: '123456789012',
      CLOUDINARY_API_SECRET: 'abcdefghijklmnopqrstuvwxyz1',
    });
    expect(createImageStore(env, logger)?.gymPrefix('g1')).toBe('fitexaa-dev/gyms/g1');
  });
});
