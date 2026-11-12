import express from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TenantIsolationError } from '../../src/lib/errors.js';
import { createLogger } from '../../src/lib/logger.js';
import { pinoHttp } from 'pino-http';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { currentTenantId } from '../../src/tenancy/context.js';
import { requireActiveTenant, resolveTenant } from '../../src/tenancy/resolver.middleware.js';
import { GYM_A_ID, GYM_B_ID, stubLookup } from '../helpers/app.js';

/** Minimal app exercising the resolver + context + error handler in isolation. */
function miniApp() {
  const app = express();
  app.use(pinoHttp({ logger: createLogger('silent') }));
  app.use(
    resolveTenant({
      lookup: stubLookup,
      baseDomains: ['localhost'],
      reservedSubdomains: ['www'],
      allowTenantHeader: false,
    }),
  );
  app.get('/ctx', async (_req, res) => {
    // Cross several async boundaries; the context must survive all of them.
    await new Promise((r) => setTimeout(r, 5));
    await Promise.resolve();
    const id = await new Promise<Types.ObjectId | undefined>((r) =>
      setImmediate(() => r(currentTenantId())),
    );
    res.json({ tenantId: id?.toHexString() ?? null });
  });
  app.get('/business', requireActiveTenant, (_req, res) => res.json({ ok: true }));
  app.get('/boom', () => {
    throw new TenantIsolationError('Query "find" tried to target another tenant');
  });
  app.use(errorHandler);
  return app;
}

describe('tenant context propagation', () => {
  const app = miniApp();

  it('carries the resolved tenant through async work', async () => {
    const a = await request(app).get('/ctx').set('Host', 'powerhouse.localhost');
    const b = await request(app).get('/ctx').set('Host', 'fitzone.localhost');
    expect(a.body.tenantId).toBe(GYM_A_ID.toHexString());
    expect(b.body.tenantId).toBe(GYM_B_ID.toHexString());
  });

  it('keeps concurrent requests for different gyms apart', async () => {
    const hosts = Array.from({ length: 40 }, (_, i) =>
      i % 2 ? 'powerhouse.localhost' : 'fitzone.localhost',
    );
    const results = await Promise.all(hosts.map((h) => request(app).get('/ctx').set('Host', h)));
    results.forEach((res, i) => {
      const expected = i % 2 ? GYM_A_ID : GYM_B_ID;
      expect(res.body.tenantId).toBe(expected.toHexString());
    });
  });

  it('has no tenant context on platform hosts', async () => {
    const res = await request(app).get('/ctx').set('Host', 'localhost');
    expect(res.body.tenantId).toBeNull();
  });

  it('blocks business routes for a suspended gym', async () => {
    const res = await request(app).get('/business').set('Host', 'ironclub.localhost');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_SUSPENDED');
  });

  it('turns an isolation violation into an opaque 500', async () => {
    const res = await request(app).get('/boom').set('Host', 'powerhouse.localhost');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/tenant/i);
  });
});
