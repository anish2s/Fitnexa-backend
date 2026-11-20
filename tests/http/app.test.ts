import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, testEnv } from '../helpers/app.js';

const app = buildTestApp();

describe('platform endpoints', () => {
  it('GET /health is up and sets security headers + request id', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toMatch(/^[\w-]+$/);
  });

  it('echoes a well-formed incoming request id and replaces a malformed one', async () => {
    const good = await request(app).get('/health').set('X-Request-Id', 'abc12345-trace');
    expect(good.headers['x-request-id']).toBe('abc12345-trace');
    const bad = await request(app).get('/health').set('X-Request-Id', '<script>');
    expect(bad.headers['x-request-id']).not.toBe('<script>');
  });

  it('GET /ready reports 503 while the database is down', async () => {
    const res = await request(buildTestApp({ dbReady: false })).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.data.checks.database).toBe('down');
  });

  it('unknown routes return the standard error envelope', async () => {
    const res = await request(app).get('/api/v1/nope').set('Host', 'localhost');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'ROUTE_NOT_FOUND' } });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('malformed JSON is a 400, not a 500', async () => {
    const res = await request(app)
      .post('/api/v1/public/tenant')
      .set('Host', 'powerhouse.localhost')
      .set('Content-Type', 'application/json')
      .send('{"oops":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('tenant resolution + public branding', () => {
  it('serves Gym A branding on Gym A host', async () => {
    const res = await request(app)
      .get('/api/v1/public/tenant')
      .set('Host', 'powerhouse.localhost:4000');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Powerhouse Fitness',
      slug: 'powerhouse',
      branding: { primaryColor: '#E11D48', defaultTheme: 'dark' },
    });
  });

  it('serves Gym B branding on Gym B host — never Gym A', async () => {
    const res = await request(app).get('/api/v1/public/tenant').set('Host', 'fitzone.yourapp.in');
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('FitZone');
    expect(JSON.stringify(res.body)).not.toContain('Powerhouse');
  });

  it('returns only whitelisted public fields', async () => {
    const res = await request(app).get('/api/v1/public/tenant').set('Host', 'powerhouse.localhost');
    expect(Object.keys(res.body.data).sort()).toEqual(['branding', 'name', 'slug', 'status']);
    expect(res.body.data.id).toBeUndefined();
  });

  it('resolves a verified custom domain', async () => {
    const res = await request(app).get('/api/v1/public/tenant').set('Host', 'app.powerhousegym.in');
    expect(res.body.data.slug).toBe('powerhouse');
  });

  it('404s an unknown gym and an archived gym the same way', async () => {
    for (const host of ['nosuchgym.localhost', 'closedgym.localhost', 'random-domain.com']) {
      const res = await request(app).get('/api/v1/public/tenant').set('Host', host);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TENANT_NOT_FOUND');
    }
  });

  it('still shows branding for a suspended gym, flagged as suspended', async () => {
    const res = await request(app).get('/api/v1/public/tenant').set('Host', 'ironclub.localhost');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('suspended');
  });

  it('requires a gym host for tenant endpoints', async () => {
    const res = await request(app).get('/api/v1/public/tenant').set('Host', 'yourapp.in');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TENANT_REQUIRED');
  });

  it('rejects nested subdomains', async () => {
    const res = await request(app)
      .get('/api/v1/public/tenant')
      .set('Host', 'x.powerhouse.localhost');
    expect(res.status).toBe(400);
  });

  it('ignores X-Tenant-Slug unless the dev fallback is enabled', async () => {
    const res = await request(app)
      .get('/api/v1/public/tenant')
      .set('Host', 'powerhouse.localhost')
      .set('X-Tenant-Slug', 'fitzone');
    expect(res.body.data.slug).toBe('powerhouse');
  });

  it('honours X-Tenant-Slug when the dev fallback is enabled', async () => {
    const devApp = buildTestApp({ env: { ALLOW_TENANT_HEADER: 'true' } });
    const res = await request(devApp)
      .get('/api/v1/public/tenant')
      .set('Host', 'localhost')
      .set('X-Tenant-Slug', 'fitzone');
    expect(res.body.data.slug).toBe('fitzone');
  });

  it('ignores X-Forwarded-Host when trust proxy is off (spoofing attempt)', async () => {
    const res = await request(app)
      .get('/api/v1/public/tenant')
      .set('Host', 'powerhouse.localhost')
      .set('X-Forwarded-Host', 'fitzone.localhost');
    expect(res.body.data.slug).toBe('powerhouse');
  });

  it('uses X-Forwarded-Host when trust proxy is configured', async () => {
    const proxied = buildTestApp({ env: { TRUST_PROXY: '1' } });
    const res = await request(proxied)
      .get('/api/v1/public/tenant')
      .set('Host', 'internal-api:4000')
      .set('X-Forwarded-Host', 'fitzone.yourapp.in');
    expect(res.body.data.slug).toBe('fitzone');
  });
});

describe('client IP behind the Next.js server (rate limits per visitor)', () => {
  // supertest connects from 127.0.0.1, i.e. it plays the Next.js server on the same machine.
  const branding = (a: ReturnType<typeof buildTestApp>, visitor?: string) => {
    const r = request(a).get('/api/v1/public/tenant').set('Host', 'powerhouse.localhost');
    return visitor ? r.set('X-Forwarded-For', visitor) : r;
  };

  it('two visitors forwarded by our proxy get separate rate limits', async () => {
    const proxied = buildTestApp({ env: { TRUST_PROXY: 'loopback', RATE_LIMIT_MAX: '3' } });
    for (let i = 0; i < 3; i++) expect((await branding(proxied, '203.0.113.10')).status).toBe(200);
    const limited = await branding(proxied, '203.0.113.10');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    // A second visitor through the same proxy still has their whole allowance.
    for (let i = 0; i < 3; i++) expect((await branding(proxied, '198.51.100.20')).status).toBe(200);
    expect((await branding(proxied, '198.51.100.20')).status).toBe(429);
  });

  it('ignores X-Forwarded-For/-Host from a caller that is not our proxy (no spoofing)', async () => {
    // Only 10.9.8.7 is "our proxy"; this connection comes from 127.0.0.1.
    const direct = buildTestApp({ env: { TRUST_PROXY: '10.9.8.7', RATE_LIMIT_MAX: '3' } });
    for (let i = 0; i < 3; i++) expect((await branding(direct, `203.0.113.${i}`)).status).toBe(200);
    // Inventing a new address each time doesn't buy a fresh allowance.
    expect((await branding(direct, '198.51.100.99')).status).toBe(429);

    const host = await request(buildTestApp({ env: { TRUST_PROXY: '10.9.8.7' } }))
      .get('/api/v1/public/tenant')
      .set('Host', 'powerhouse.localhost')
      .set('X-Forwarded-Host', 'fitzone.localhost');
    expect(host.body.data.slug).toBe('powerhouse');
  });

  it('honours X-Forwarded-Host from a trusted proxy address', async () => {
    const res = await request(buildTestApp({ env: { TRUST_PROXY: 'loopback' } }))
      .get('/api/v1/public/tenant')
      .set('Host', 'internal-api:4000')
      .set('X-Forwarded-Host', 'fitzone.yourapp.in');
    expect(res.body.data.slug).toBe('fitzone');
  });
});

describe('CORS', () => {
  it('allows a configured exact origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it("allows a gym's own origin on that gym's host", async () => {
    const res = await request(app)
      .get('/health')
      .set('Host', 'powerhouse.yourapp.in')
      .set('Origin', 'https://powerhouse.yourapp.in');
    expect(res.headers['access-control-allow-origin']).toBe('https://powerhouse.yourapp.in');
  });

  it("refuses another gym's origin (no cross-gym credentialed calls)", async () => {
    const res = await request(app)
      .get('/health')
      .set('Host', 'powerhouse.yourapp.in')
      .set('Origin', 'https://fitzone.yourapp.in');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses unknown and look-alike origins', async () => {
    for (const origin of [
      'https://evil.com',
      'https://yourapp.in.evil.com',
      'https://a.b.yourapp.in',
      'http://powerhouse.yourapp.in',
    ]) {
      const res = await request(app)
        .get('/health')
        .set('Host', 'powerhouse.yourapp.in')
        .set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});

describe('rate limiting', () => {
  // The production default, not a test override: one visitor gets 300 requests a minute, then 429.
  // (The dashboard's e2e run sets its own higher limit, because all its browsers share one IP.)
  it('a normal visitor gets 429 past the default 300 requests per minute', async () => {
    const saved = { max: process.env.RATE_LIMIT_MAX, win: process.env.RATE_LIMIT_WINDOW_MS };
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    try {
      const env = testEnv();
      expect([env.RATE_LIMIT_MAX, env.RATE_LIMIT_WINDOW_MS]).toEqual([300, 60_000]);
      const app = buildTestApp();
      const hit = () =>
        request(app).get('/api/v1/public/tenant').set('Host', 'powerhouse.localhost');
      for (let i = 1; i <= 300; i++) {
        const res = await hit();
        if (res.status !== 200) throw new Error(`request ${i} answered ${res.status}`);
      }
      const res = await hit();
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      if (saved.max !== undefined) process.env.RATE_LIMIT_MAX = saved.max;
      if (saved.win !== undefined) process.env.RATE_LIMIT_WINDOW_MS = saved.win;
    }
  });

  it('returns 429 with the standard envelope past the limit', async () => {
    const limited = buildTestApp({ env: { RATE_LIMIT_MAX: '2' } });
    const hit = () =>
      request(limited).get('/api/v1/public/tenant').set('Host', 'powerhouse.localhost');
    await hit();
    await hit();
    const res = await hit();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});
