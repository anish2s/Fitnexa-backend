import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/app.js';

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

describe('CORS', () => {
  it('allows a configured exact origin and wildcard gym origins', async () => {
    for (const origin of ['http://localhost:3000', 'https://powerhouse.yourapp.in']) {
      const res = await request(app).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('refuses unknown and look-alike origins', async () => {
    for (const origin of [
      'https://evil.com',
      'https://yourapp.in.evil.com',
      'https://a.b.yourapp.in',
      'http://powerhouse.yourapp.in',
    ]) {
      const res = await request(app).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});

describe('rate limiting', () => {
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
