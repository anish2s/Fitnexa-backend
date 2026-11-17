import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { listRoutes, type MountedRouter } from '../../src/openapi/generate.js';
import { currentSpec } from '../../src/scripts/export-openapi.js';
import { buildTestApp } from '../helpers/app.js';

const committed = JSON.parse(
  readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'),
);
const app = buildTestApp();
const spec = currentSpec();
const ops = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.entries(methods as Record<string, Record<string, unknown>>).map(([method, op]) => ({
    path,
    method,
    op,
  })),
);

describe('OpenAPI document', () => {
  it('docs/openapi.json is up to date with the code (run `npm run openapi`)', () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(spec)));
  });

  it('documents every mounted route, once', () => {
    const routes = listRoutes(app.locals.mounts as MountedRouter[]);
    expect(ops).toHaveLength(routes.length);
    expect(new Set(ops.map((o) => o.op.operationId)).size).toBe(ops.length);
    expect(ops.length).toBeGreaterThan(90);
  });

  it('is OpenAPI 3.1 with path params declared and responses for every operation', () => {
    expect(spec.openapi).toBe('3.1.0');
    for (const { path, method, op } of ops) {
      const declared = ((op.parameters as { name: string; in: string }[] | undefined) ?? [])
        .filter((p) => p.in === 'path')
        .map((p) => p.name);
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(declared, `${method} ${path}`).toEqual(inPath);
      expect(Object.keys(op.responses as object).length, `${method} ${path}`).toBeGreaterThan(1);
    }
  });

  it('carries request schemas, auth and permissions from the real middleware', () => {
    const pay = (spec.paths as Record<string, Record<string, Record<string, unknown>>>)[
      '/api/v1/memberships/{id}/payments'
    ]!.post!;
    expect(pay.security).toEqual([{ bearerAuth: [] }]);
    expect(pay.description).toContain('`payments:record`');
    expect(JSON.stringify(pay.requestBody)).toContain('"bank_transfer"');
    expect(JSON.stringify(pay.parameters)).toContain('Idempotency-Key');
    const receipt = (spec.paths as Record<string, Record<string, Record<string, unknown>>>)[
      '/api/v1/payments/{id}/receipt'
    ]!.get!;
    expect(JSON.stringify(receipt.responses)).toContain('application/pdf');
    const imp = (spec.paths as Record<string, Record<string, Record<string, unknown>>>)[
      '/api/v1/members/import'
    ]!.post!;
    expect(JSON.stringify(imp.requestBody)).toContain('text/csv');
  });

  it('is served at /api/v1/openapi.json, and Swagger UI at /api/docs outside production', async () => {
    const res = await request(app).get('/api/v1/openapi.json').set('Host', 'powerhouse.localhost');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths).toEqual(JSON.parse(JSON.stringify(spec.paths)));
    const ui = await request(app).get('/api/docs').set('Host', 'powerhouse.localhost');
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger-ui-dist@5.17.14');
  });
});
