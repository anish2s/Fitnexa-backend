import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

/**
 * Metadata attached to middleware functions so the app's own routers can be read back: the
 * OpenAPI document and the route security audit (tests) are generated from what is actually
 * mounted, not from a hand-kept list that could drift.
 */
export type RouteMeta =
  | { kind: 'validate'; schemas: { body?: ZodType; query?: ZodType; params?: ZodType } }
  | { kind: 'authenticate' }
  | { kind: 'authorize'; all: string[] }
  | { kind: 'authorizeAny'; any: string[] }
  | { kind: 'platformAdmin' }
  | { kind: 'notWhileImpersonating' }
  | { kind: 'header'; name: string; required: boolean | 'conditional'; description: string }
  | { kind: 'rawBody'; contentType: string }
  | { kind: 'produces'; contentType: string };

const META = Symbol.for('fitexaa.route-meta');

export function tag<T extends RequestHandler>(fn: T, meta: RouteMeta): T {
  (fn as unknown as Record<symbol, RouteMeta[]>)[META] = [
    ...(((fn as unknown as Record<symbol, RouteMeta[]>)[META] as RouteMeta[] | undefined) ?? []),
    meta,
  ];
  return fn;
}

export function metaOf(fn: unknown): RouteMeta[] {
  return ((fn as Record<symbol, RouteMeta[]> | undefined)?.[META] as RouteMeta[] | undefined) ?? [];
}

/** A no-op middleware that only documents a request header (e.g. Idempotency-Key). */
export function documentsHeader(
  name: string,
  required: boolean | 'conditional',
  description: string,
): RequestHandler {
  return tag((_req, _res, next) => next(), { kind: 'header', name, required, description });
}

/** A no-op middleware that documents a non-JSON response (PDF receipts). */
export function produces(contentType: string): RequestHandler {
  return tag((_req, _res, next) => next(), { kind: 'produces', contentType });
}
