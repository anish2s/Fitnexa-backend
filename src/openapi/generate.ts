import type { Router } from 'express';
import { z, type ZodType } from 'zod';
import { metaOf, type RouteMeta } from '../lib/route-meta.js';

/**
 * OpenAPI 3.1 generated from the mounted Express routers: paths and methods from the routers
 * themselves, request schemas from the Zod schemas the routes validate with, auth and permissions
 * from the middleware tags. Nothing here is hand-maintained per endpoint, so it can't drift.
 */
export interface MountedRouter {
  base: string;
  path: string;
  router: Router;
}

export interface RouteInfo {
  method: string;
  /** Express path, e.g. /api/v1/members/:id */
  path: string;
  metas: RouteMeta[];
}

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle: unknown;
};

/** Every route of every mounted router, with the middleware metadata that applies to it. */
export function listRoutes(mounts: MountedRouter[]): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const m of mounts) {
    const routerLevel: RouteMeta[] = [];
    for (const layer of (m.router as unknown as { stack: Layer[] }).stack) {
      if (!layer.route) {
        routerLevel.push(...metaOf(layer.handle)); // router.use(authenticate(...), authorize(...))
        continue;
      }
      const routeMetas = layer.route.stack.flatMap((l) => metaOf(l.handle));
      for (const method of Object.keys(layer.route.methods).filter(
        (k) => layer.route!.methods[k],
      )) {
        const path = `${m.base}${m.path}${layer.route.path === '/' ? '' : layer.route.path}` || '/';
        out.push({ method, path, metas: [...routerLevel, ...routeMetas] });
      }
    }
  }
  return out;
}

const PUBLIC_NOTE = 'No sign-in required.';

function jsonSchema(schema: ZodType) {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete js.$schema;
  return js;
}

function describeAccess(metas: RouteMeta[]) {
  const lines: string[] = [];
  const authed = metas.some((m) => m.kind === 'authenticate');
  if (!authed) lines.push(PUBLIC_NOTE);
  for (const m of metas) {
    if (m.kind === 'platformAdmin') lines.push('Super admin, platform host only.');
    if (m.kind === 'authorize')
      lines.push(
        `Requires permission${m.all.length > 1 ? 's' : ''}: ${m.all.map((p) => `\`${p}\``).join(', ')}.`,
      );
    if (m.kind === 'authorizeAny')
      lines.push(`Requires one of: ${m.any.map((p) => `\`${p}\``).join(', ')}.`);
    if (m.kind === 'notWhileImpersonating')
      lines.push('Refused while a super admin is signed in as the owner.');
  }
  return { authed, text: lines.join(' ') };
}

const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const opId = (method: string, path: string) =>
  method +
  path
    .replace(/^\/api\/v1/, '')
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith(':') ? 'By' + seg[1]!.toUpperCase() + seg.slice(2) : seg))
    .map((seg) => seg.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase()))
    .map((seg) => seg[0]!.toUpperCase() + seg.slice(1))
    .join('');

const ERRORS: Record<string, string> = {
  '400': 'Bad request (malformed input, wrong host, invalid link/signature/pass)',
  '401': 'Not signed in, token expired, or token from another gym/host',
  '403': 'Signed in but not allowed (missing permission, suspended gym)',
  '404': 'Not found (also for records of other gyms)',
  '409': 'Conflict with current state (duplicates, overlaps, wrong status)',
  '422': 'Validation failed (`error.details` lists each problem)',
  '429': 'Rate limited or account locked',
};

export function buildOpenApi(mounts: MountedRouter[], info: { version: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of listRoutes(mounts)) {
    const access = describeAccess(r.metas);
    const validate = r.metas.find(
      (m): m is Extract<RouteMeta, { kind: 'validate' }> => m.kind === 'validate',
    );
    const schemas = validate?.schemas ?? {};
    const parameters: Record<string, unknown>[] = [];

    // Path params: from the params schema when there is one, otherwise plain strings.
    const pathParams = [...r.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((x) => x[1]!);
    const paramProps = schemas.params
      ? ((jsonSchema(schemas.params).properties ?? {}) as Record<string, unknown>)
      : {};
    for (const name of pathParams) {
      parameters.push({
        name,
        in: 'path',
        required: true,
        schema: paramProps[name] ?? { type: 'string' },
      });
    }
    if (schemas.query) {
      const q = jsonSchema(schemas.query) as {
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      for (const [name, schema] of Object.entries(q.properties ?? {})) {
        const { description, ...rest } = schema;
        parameters.push({
          name,
          in: 'query',
          required: (q.required ?? []).includes(name),
          schema: rest,
          ...(description ? { description } : {}),
        });
      }
    }
    for (const m of r.metas) {
      if (m.kind === 'header') {
        parameters.push({
          name: m.name,
          in: 'header',
          required: m.required === true,
          description: m.description,
          schema: { type: 'string' },
        });
      }
    }

    const raw = r.metas.find(
      (m): m is Extract<RouteMeta, { kind: 'rawBody' }> => m.kind === 'rawBody',
    );
    const requestBody = raw
      ? { required: true, content: { [raw.contentType]: { schema: { type: 'string' } } } }
      : schemas.body
        ? { required: true, content: { 'application/json': { schema: jsonSchema(schemas.body) } } }
        : undefined;

    const produced = r.metas.find(
      (m): m is Extract<RouteMeta, { kind: 'produces' }> => m.kind === 'produces',
    );
    const ok = produced
      ? {
          description: 'OK',
          content: { [produced.contentType]: { schema: { type: 'string', format: 'binary' } } },
        }
      : {
          description: 'Success envelope (see API.md for the `data` of each endpoint)',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
        };

    const errorCodes = [
      '400',
      '404',
      '409',
      '429',
      ...(access.authed ? ['401', '403'] : []),
      ...(validate || raw ? ['422'] : []),
    ];
    const responses: Record<string, unknown> = { [r.method === 'post' ? '2XX' : '200']: ok };
    for (const code of errorCodes.sort())
      responses[code] = { $ref: `#/components/responses/E${code}` };

    const segment = r.path.replace(/^\/api\/v1\//, '').split('/')[0] || 'health';
    const p = toOpenApiPath(r.path);
    paths[p] ??= {};
    paths[p]![r.method] = {
      operationId: opId(r.method, r.path),
      tags: [segment],
      summary: `${r.method.toUpperCase()} ${p}`,
      description: access.text,
      ...(access.authed ? { security: [{ bearerAuth: [] }] } : { security: [] }),
      ...(parameters.length ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses,
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Gym SaaS API',
      version: info.version,
      description:
        'Multi-tenant gym management API. The gym is chosen by the **host** (`<gym>.yourapp.in`); ' +
        'super admin endpoints live on the platform host. Money is integer paise; dates are `YYYY-MM-DD` ' +
        "in the gym's time zone. Full behaviour per endpoint: docs/API.md.",
    },
    servers: [{ url: 'https://{gym}.yourapp.in', variables: { gym: { default: 'powerhouse' } } }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Access token from /api/v1/auth/login or /magic-link/verify (15 min). Refresh via the HttpOnly cookie.',
        },
      },
      schemas: {
        Success: {
          type: 'object',
          required: ['success', 'data'],
          properties: {
            success: { const: true },
            data: {},
            meta: { type: 'object', additionalProperties: true },
          },
        },
        Error: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: { const: false },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: {},
                requestId: { type: 'string' },
              },
            },
          },
        },
      },
      responses: Object.fromEntries(
        Object.entries(ERRORS).map(([code, description]) => [
          `E${code}`,
          {
            description,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        ]),
      ),
    },
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  };
}
