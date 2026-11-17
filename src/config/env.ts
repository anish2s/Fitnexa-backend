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
    /** Per IP + gym + identifier, for login, email-link and forgot-password requests. */
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60_000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

    // --- Authentication ---
    /** HMAC key for access tokens. 32+ random bytes, e.g. `openssl rand -base64 48`. */
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().default('gym-saas-api'),
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    MAGIC_LINK_TTL_MIN: z.coerce.number().int().min(5).max(60).default(15),
    PASSWORD_RESET_TTL_MIN: z.coerce.number().int().min(10).max(120).default(30),
    INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(72),
    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_LOCK_MIN: z.coerce.number().int().min(1).max(1440).default(15),
    /** Refresh cookie Secure flag. Must be true in production (HTTPS). */
    COOKIE_SECURE: z
      .enum(['true', 'false', '1', '0'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),

    // --- Links in emails ---
    /** Gym app URL. {slug} is replaced, e.g. https://{slug}.yourapp.in */
    GYM_APP_URL_TEMPLATE: z
      .string()
      .default('http://{slug}.localhost:3000')
      .refine((v) => v.includes('{slug}'), 'GYM_APP_URL_TEMPLATE must contain {slug}'),

    // --- Email ---
    /** log: writes emails to the log (dev only). memory: kept in memory (tests). resend: real. */
    MAIL_TRANSPORT: z.enum(['log', 'memory', 'resend']).default('log'),
    /** Must be an address on a domain verified in the provider, e.g. `Gym App <no-reply@yourapp.in>`. */
    MAIL_FROM: z.string().trim().min(3).default('Gym App <no-reply@localhost>'),
    RESEND_API_KEY: z.string().trim().optional(),

    // --- Scheduled jobs (renewal reminders) ---
    /** Run cron jobs in this process. Safe with several instances (Mongo lease lock). */
    JOBS_ENABLED: z
      .enum(['true', 'false', '1', '0'])
      .default('true')
      .transform((v) => v === 'true' || v === '1'),

    // --- Attendance QR ---
    /**
     * Signs members' rotating QR passes (per-gym keys are derived from it). Optional: defaults to a
     * key derived from JWT_ACCESS_SECRET, so rotating that also invalidates passes (they live ~1 min).
     */
    QR_SIGNING_SECRET: z
      .string()
      .min(32, 'QR_SIGNING_SECRET must be at least 32 characters')
      .optional(),

    // --- Online payments (Razorpay, each gym's own account) ---
    /**
     * 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts gyms' Razorpay secrets at rest.
     * Without it, gyms can't connect Razorpay (desk payments work regardless). Rotating it makes
     * stored secrets unreadable: gyms must re-enter their keys.
     */
    PAYMENTS_ENCRYPTION_KEY: z
      .string()
      .trim()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'Must be 32 bytes, base64-encoded')
      .optional(),
    /** Live keys move real money. Off until the owner explicitly approves going live. */
    RAZORPAY_ALLOW_LIVE: bool,

    /** Swagger UI at /api/docs. Always on outside production; in production only when true. */
    ENABLE_API_DOCS: bool,

    // --- Image uploads (Cloudinary). All three or none; without them uploads answer 503. ---
    CLOUDINARY_CLOUD_NAME: z
      .string()
      .trim()
      .regex(/^[a-z0-9_-]{1,64}$/i, 'Invalid Cloudinary cloud name')
      .optional(),
    CLOUDINARY_API_KEY: z
      .string()
      .trim()
      .regex(/^\d{6,32}$/, 'Invalid Cloudinary API key')
      .optional(),
    /** Cloudinary secrets are ~27 URL-safe characters; a shorter value is almost always a bad copy. */
    CLOUDINARY_API_SECRET: z
      .string()
      .trim()
      .regex(
        /^[A-Za-z0-9_-]{20,64}$/,
        'Invalid Cloudinary API secret (copy the full value from Settings → API Keys)',
      )
      .optional(),
    /** Top-level folder, so dev and production uploads never mix in one Cloudinary account. */
    CLOUDINARY_FOLDER: z
      .string()
      .trim()
      .regex(/^[a-z0-9_-]{1,40}$/, 'Lowercase letters, digits, _ and - only')
      .default('gym-saas-dev'),
  })
  .transform((env) => ({
    ...env,
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
  }))
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE must be true in production',
      });
    }
    if (env.NODE_ENV === 'production' && ['log', 'memory'].includes(env.MAIL_TRANSPORT)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'A real email provider (MAIL_TRANSPORT=resend) is required in production',
      });
    }
    if (
      env.MAIL_TRANSPORT === 'resend' &&
      !/^re_[A-Za-z0-9_]{8,}$/.test(env.RESEND_API_KEY ?? '')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'MAIL_TRANSPORT=resend needs RESEND_API_KEY (starts with re_)',
      });
    }
    const cloudinary = [
      env.CLOUDINARY_CLOUD_NAME,
      env.CLOUDINARY_API_KEY,
      env.CLOUDINARY_API_SECRET,
    ].filter(Boolean).length;
    if (cloudinary !== 0 && cloudinary !== 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['CLOUDINARY_API_SECRET'],
        message: 'Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET together',
      });
    }
    if (env.MAIL_TRANSPORT === 'resend' && /@localhost\b/i.test(env.MAIL_FROM)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_FROM'],
        message: 'MAIL_FROM must use a domain verified in Resend',
      });
    }
    if (env.NODE_ENV === 'production' && !env.GYM_APP_URL_TEMPLATE.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['GYM_APP_URL_TEMPLATE'],
        message: 'GYM_APP_URL_TEMPLATE must use https in production',
      });
    }
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
