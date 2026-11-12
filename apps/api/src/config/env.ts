import { z } from 'zod';

/**
 * All configuration comes from environment variables and is validated once at startup.
 * The process refuses to boot with an invalid configuration (fail fast, never half-configured).
 */
const splitCsv = (s: string) =>
  s
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

const csv = z.string().default('').transform(splitCsv);

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

    /** Root domains the platform serves tenants under, e.g. "yourapp.in,localhost". */
    BASE_DOMAINS: csv.pipe(z.array(z.string()).min(1, 'BASE_DOMAINS needs at least one domain')),
    /** Subdomains that never resolve to a gym (platform/admin surfaces). */
    RESERVED_SUBDOMAINS: z
      .string()
      .default('www,api,app,admin,platform,static,assets,mail,status')
      .transform(splitCsv),

    /** Browser origins allowed by CORS. Wildcards like https://*.yourapp.in are supported. */
    CORS_ORIGINS: csv,

    /**
     * Express "trust proxy" setting. Only set when the API really sits behind a proxy
     * (Cloudflare, a load balancer, the Next.js server), otherwise X-Forwarded-* headers can be spoofed.
     */
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

    /** Dev-only escape hatch: resolve tenant from the X-Tenant-Slug header. Forbidden in production. */
    ALLOW_TENANT_HEADER: bool,

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.ALLOW_TENANT_HEADER) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOW_TENANT_HEADER'],
        message: 'ALLOW_TENANT_HEADER must be false in production',
      });
    }
    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must be set in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Lazily parsed so tests can set process.env before first use. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test helper: forget the cached configuration. */
export function resetEnvCache(): void {
  cached = undefined;
}
