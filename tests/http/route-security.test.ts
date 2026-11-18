import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { redactQuery } from '../../src/app.js';
import { listRoutes, type MountedRouter, type RouteInfo } from '../../src/openapi/generate.js';
import { buildTestApp } from '../helpers/app.js';

/**
 * Security audit over EVERY mounted route, read from the real routers. A new route that forgets
 * sign-in, a permission check or input validation fails here, not in production.
 */
const app = buildTestApp();
const routes = listRoutes([
  ...(app.locals.mounts as MountedRouter[]),
  // Not part of the documented API (OpenAPI document, Swagger UI), but audited all the same.
  ...(app.locals.unlisted as MountedRouter[]),
]);
const key = (r: RouteInfo) => `${r.method.toUpperCase()} ${r.path}`;
const has = (r: RouteInfo, kind: string) => r.metas.some((m) => m.kind === kind);

/** The only routes anyone may call without signing in. Each one is deliberate. */
const PUBLIC = new Set([
  'GET /health',
  'GET /ready',
  'GET /api/v1/public/tenant', // branding for the login page
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh', // proves itself with the HttpOnly refresh cookie
  'GET /api/v1/auth/session', // same cookie, read-only: role for the web server's page guards
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/magic-link',
  'POST /api/v1/auth/magic-link/verify',
  'POST /api/v1/auth/password/forgot',
  'POST /api/v1/auth/password/reset',
  'POST /api/v1/webhooks/razorpay', // proves itself with the gym's webhook signature
  // The API contract: describes routes, never data; gym-saas-web generates its client from it.
  'GET /api/v1/openapi.json',
  // Swagger UI (off in production unless ENABLE_API_DOCS=true) and its locally served assets.
  'GET /api/docs',
  'GET /api/docs/init.js',
  'GET /api/docs/swagger-ui.css',
  'GET /api/docs/swagger-ui-bundle.js',
]);

/** Every route handler registered anywhere in the app, found by walking Express's own stacks. */
function countAppRoutes(stack: unknown[]): number {
  let n = 0;
  for (const layer of stack as {
    route?: { methods: Record<string, boolean> };
    handle?: { stack?: unknown[] };
  }[]) {
    if (layer.route) n += Object.values(layer.route.methods).filter(Boolean).length;
    else if (Array.isArray(layer.handle?.stack)) n += countAppRoutes(layer.handle.stack);
  }
  return n;
}

/** Signed-in routes any gym user may call about THEMSELVES (no permission needed by design). */
const SELF_SERVICE = new Set([
  'GET /api/v1/auth/me',
  'GET /api/v1/auth/sessions',
  'DELETE /api/v1/auth/sessions/:id',
  'POST /api/v1/auth/logout-all',
  'POST /api/v1/auth/password/change',
  'POST /api/v1/auth/impersonation/end',
]);

/** Writes that take no request body (the id in the path is the whole input). */
const BODYLESS_WRITES =
  /\/(activate|deactivate|archive|restore|invite|owner-invite|retry|cancel|logout|logout-all|refresh|impersonation\/end)$|\/photo$|^\/api\/v1\/members\/import$|^\/api\/v1\/webhooks\//;

describe('route security audit (all routes)', () => {
  it('found the whole API', () => {
    expect(routes.length).toBeGreaterThan(90);
  });

  it('audits every route the app serves, including ones outside /api/v1 routers', () => {
    const stack = (app as unknown as { router: { stack: unknown[] } }).router.stack;
    expect(routes.length).toBe(countAppRoutes(stack));
  });

  it('only the deliberate public routes skip sign-in', () => {
    const open = routes
      .filter((r) => !has(r, 'authenticate'))
      .map(key)
      .sort();
    expect(open).toEqual([...PUBLIC].sort());
  });

  it('every gym route checks a permission (except self-service on your own account)', () => {
    const missing = routes
      .filter((r) => has(r, 'authenticate') && !r.path.startsWith('/api/v1/platform'))
      .filter((r) => !has(r, 'authorize') && !has(r, 'authorizeAny'))
      .map(key)
      .filter((k) => !SELF_SERVICE.has(k));
    expect(missing).toEqual([]);
  });

  it('every super admin route requires a platform admin', () => {
    const platform = routes.filter((r) => r.path.startsWith('/api/v1/platform'));
    expect(platform.length).toBeGreaterThan(10);
    expect(platform.filter((r) => !has(r, 'platformAdmin')).map(key)).toEqual([]);
  });

  it('every :id in a path is validated (ObjectId), so bad ids are 422, never a DB error', () => {
    const unvalidated = routes
      .filter((r) => /:\w+/.test(r.path))
      .filter((r) => !r.metas.some((m) => m.kind === 'validate' && m.schemas.params))
      .map(key);
    expect(unvalidated).toEqual([]);
  });

  it('every write with a body validates it', () => {
    const unvalidated = routes
      .filter((r) => ['post', 'put', 'patch'].includes(r.method))
      .filter((r) => !BODYLESS_WRITES.test(r.path) && !r.path.endsWith('/razorpay-order'))
      .filter((r) => !r.metas.some((m) => m.kind === 'validate' && m.schemas.body))
      .map(key);
    expect(unvalidated).toEqual([]);
  });

  it('money-moving routes require an Idempotency-Key header', () => {
    const money = routes.filter(
      (r) => r.method === 'post' && /\/payments$|\/refunds$/.test(r.path),
    );
    expect(money.map(key).sort()).toEqual([
      'POST /api/v1/memberships/:id/payments',
      'POST /api/v1/payments/:id/refunds',
    ]);
    for (const r of money) {
      expect(
        r.metas.some(
          (m) => m.kind === 'header' && m.name === 'Idempotency-Key' && m.required === true,
        ),
        key(r),
      ).toBe(true);
    }
  });

  it('irreversible or payout-changing actions are blocked while a super admin impersonates', () => {
    const sensitive = routes.filter((r) =>
      /\/erase$|\/payment-gateway\/razorpay$|\/password\/change$|\/logout-all$/.test(r.path),
    );
    expect(sensitive.length).toBeGreaterThanOrEqual(5);
    expect(sensitive.filter((r) => !has(r, 'notWhileImpersonating')).map(key)).toEqual([]);
  });
});

describe('request log redaction', () => {
  it('keeps safe query values and hides the rest', () => {
    expect(redactQuery('/api/v1/members?q=98111%2011111&page=2&limit=20')).toBe(
      '/api/v1/members?q=[redacted]&page=2&limit=20',
    );
    expect(redactQuery('/api/v1/members/x/whatsapp?template=custom&text=Hi%20Arjun')).toBe(
      '/api/v1/members/x/whatsapp?template=custom&text=[redacted]',
    );
    expect(redactQuery('/health')).toBe('/health');
  });
});

describe('response caching', () => {
  const app = buildTestApp();
  it('API responses default to no-store (errors too); public branding opts in to caching', async () => {
    const denied = await request(app).get('/api/v1/staff').set('Host', 'powerhouse.localhost');
    expect(denied.status).toBe(401);
    expect(denied.headers['cache-control']).toBe('no-store');
    const brand = await request(app)
      .get('/api/v1/public/tenant')
      .set('Host', 'powerhouse.localhost');
    expect(brand.headers['cache-control']).toBe('public, max-age=60');
  });
});
