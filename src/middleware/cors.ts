import cors from 'cors';

/**
 * Allow-list CORS. Entries may contain one leading wildcard label: https://*.yourapp.in
 * matches https://powerhouse.yourapp.in but not https://yourapp.in or https://evil.com/yourapp.in.
 */
export function originMatcher(allowed: readonly string[]) {
  const patterns = allowed.map((entry) => {
    const m = /^(https?):\/\/\*\.(.+)$/.exec(entry);
    if (!m) return (origin: string) => origin === entry;
    const [, scheme, rest] = m;
    const re = new RegExp(
      `^${scheme}://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.${rest!.replace(/[.]/g, '\\.')}$`,
    );
    return (origin: string) => re.test(origin);
  });
  return (origin: string) => patterns.some((p) => p(origin.toLowerCase()));
}

export function corsMiddleware(allowed: readonly string[]) {
  const matches = originMatcher(allowed);
  return cors({
    origin(origin, cb) {
      // Same-origin and non-browser requests have no Origin header.
      if (!origin) return cb(null, true);
      cb(null, matches(origin));
    },
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
}
