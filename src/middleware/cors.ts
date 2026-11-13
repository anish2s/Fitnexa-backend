import cors from 'cors';
import type { Request } from 'express';

/**
 * Allow-list CORS.
 *
 * - Exact entries (http://localhost:3000) match that origin only.
 * - Wildcard entries (https://*.yourapp.in) match a single-label subdomain of that domain AND only
 *   when the origin's hostname equals the host the request was sent to. So
 *   https://powerhouse.yourapp.in may call powerhouse's API, but https://fitzone.yourapp.in may NOT
 *   call powerhouse's API with credentials. Different gyms are different trust boundaries.
 */
export function originMatcher(allowed: readonly string[]) {
  const patterns = allowed.map((entry) => {
    const m = /^(https?):\/\/\*\.(.+)$/.exec(entry);
    if (!m) return (origin: string) => origin === entry;
    const [, scheme, rest] = m;
    const re = new RegExp(
      `^${scheme}://([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.${rest!.replace(/[.]/g, '\\.')})(?::\\d+)?$`,
    );
    return (origin: string, requestHost?: string) => {
      const hit = re.exec(origin);
      return Boolean(hit && requestHost && hit[1] === requestHost);
    };
  });
  return (origin: string, requestHost?: string) =>
    patterns.some((p) => p(origin.toLowerCase(), requestHost?.toLowerCase()));
}

export function corsMiddleware(allowed: readonly string[]) {
  const matches = originMatcher(allowed);
  return cors((req, cb) => {
    const origin = req.headers.origin;
    cb(null, {
      // Same-origin and non-browser requests have no Origin header.
      origin: !origin || matches(origin, (req as Request).hostname),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Request-Id',
        'Idempotency-Key',
        'X-Tenant-Slug',
      ],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    });
  });
}
