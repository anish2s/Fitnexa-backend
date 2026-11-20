import { isIP } from 'node:net';
import { z } from 'zod';
import { DEFAULT_ENABLED_MAIL_KINDS, MAIL_KINDS } from '../lib/mail-kinds.js';
import { isPlusPattern, plusPatternExample } from '../lib/mail-recipients.js';

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

/** Named ranges Express ("proxy-addr") understands. */
const TRUST_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** "10.0.0.5", "10.0.0.0/8", "fd00::/8", or a named range. */
function isTrustEntry(v: string): boolean {
  if (TRUST_NAMES.has(v)) return true;
  const [addr = '', bits, extra] = v.split('/');
  const family = isIP(addr);
  if (!family || extra !== undefined) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (family === 4 ? 32 : 128);
}

/**
 * TRUST_PROXY: either a hop count ("0" = trust nobody, "1" = the first hop) or, preferably, the
 * addresses of our own proxy (the Next.js server): "loopback", "10.0.0.0/8", "loopback,fd00::/8"…
 * With addresses, X-Forwarded-For / X-Forwarded-Host are honoured only on connections that really
 * come from that proxy; anyone else reaching the API directly is identified by their own address.
 */
const trustProxy = z
  .string()
  .trim()
  .default('0')
  .transform((v, ctx): number | string[] => {
    if (/^\d+$/.test(v)) {
      const n = Number(v);
      if (n <= 5) return n;
      ctx.addIssue({ code: 'custom', message: 'A TRUST_PROXY hop count must be 0–5' });
      return z.NEVER;
    }
    const list = splitCsv(v);
    const bad = list.filter((e) => !isTrustEntry(e));
    if (list.length === 0 || bad.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `TRUST_PROXY must be a hop count or proxy addresses (IP, CIDR, loopback, linklocal, uniquelocal); invalid: ${bad.join(', ') || '(empty)'}`,
      });
      return z.NEVER;
    }
    return list;
  });

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
    /**
     * Root domains of the STAFF dashboard, e.g. "staff.localhost" (owner's decision 2026-11-20:
     * members use the gym's main address, staff a separate one; the production domain is decided
     * later). `<slug>.<staff base>` is the same gym as `<slug>.<base>`. Empty = no split: the main
     * address serves staff and members alike (the behaviour before Phase 3).
     */
    STAFF_BASE_DOMAINS: csv,
    /**
     * Member addresses by suffix instead of by domain (owner's layout, 2026-11-20): with "-pwa",
     * `<slug>-pwa.<base>` is the member app and `<slug>.<base>` the staff dashboard. One level under the
     * base domain, so the free wildcard certificate covers both. Empty = off.
     */
    MEMBER_HOST_SUFFIX: z
      .string()
      .trim()
      .regex(/^(-[a-z0-9]{1,10})?$/, 'Use a hyphen and 1–10 lowercase letters or digits, e.g. -pwa')
      .default(''),
    /** Subdomains that never resolve to a gym (platform/admin surfaces). */
    RESERVED_SUBDOMAINS: z
      .string()
      .default('www,api,app,admin,platform,static,assets,mail,status,pwa,staff')
      .transform(splitCsv),

    /** Browser origins allowed by CORS. Wildcards like https://*.yourapp.in are supported. */
    CORS_ORIGINS: csv,

    /**
     * Express "trust proxy" setting: who may set X-Forwarded-For/-Host. The API sits behind the
     * Next.js server, which overwrites both; list that server's address(es) here. A hop count trusts
     * whoever connects, so production refuses it (see the check below and docs/DEPLOYMENT.md).
     */
    TRUST_PROXY: trustProxy,

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
    JWT_ISSUER: z.string().default('fitexaa-backend'),
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
    /**
     * Staff dashboard URL for owner/staff emails (password reset, invites), e.g.
     * https://{slug}.staff.yourapp.in. Defaults to GYM_APP_URL_TEMPLATE (no separate staff address).
     */
    STAFF_APP_URL_TEMPLATE: z
      .string()
      .optional()
      .refine(
        (v) => v === undefined || v.includes('{slug}'),
        'STAFF_APP_URL_TEMPLATE must contain {slug}',
      ),

    // --- Email ---
    /**
     * log: writes emails to the log (dev only). memory: kept in memory (tests). file: appends each
     * email as a JSON line to MAIL_FILE (dev/e2e only, so tests can read sign-in links). resend: real.
     */
    MAIL_TRANSPORT: z.enum(['log', 'memory', 'file', 'resend']).default('log'),
    /** For MAIL_TRANSPORT=file: path of the JSON-lines file, relative to the backend folder. */
    MAIL_FILE: z.string().trim().min(1).default('tmp/mail.jsonl'),
    /** Must be an address on a domain verified in the provider, e.g. `Fitexaa <no-reply@yourapp.in>`.
     * Gym mail keeps the address but shows the gym's name as the sender (see senderFor). */
    MAIL_FROM: z.string().trim().min(3).default('Fitexaa <no-reply@localhost>'),
    RESEND_API_KEY: z.string().trim().optional(),
    /** Email kinds that may really be sent; any other kind is skipped and logged. */
    MAIL_ENABLED_KINDS: z
      .string()
      .default(DEFAULT_ENABLED_MAIL_KINDS.join(','))
      .transform(splitCsv)
      .pipe(z.array(z.enum(MAIL_KINDS))),
    /**
     * Outside production, the only addresses real mail may go to (comma-separated); mail to anyone
     * else is written to the log instead. `name+*@domain` matches every plus-address of that inbox
     * (see mail-recipients.ts). Empty = nobody. Not allowed in production.
     */
    MAIL_ALLOWED_RECIPIENTS: csv.pipe(
      z.array(
        z.string().refine(
          (v) =>
            z
              .string()
              .email()
              .safeParse(isPlusPattern(v) ? plusPatternExample(v) : v).success,
          'Not an email address or a name+*@domain pattern',
        ),
      ),
    ),

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
      .default('fitexaa-dev'),
    /**
     * Where this server calls Cloudinary (resource lookups, deletes). Tests only: the dashboard's e2e
     * setup points it at a local mock so test runs never touch a real account. Production refuses
     * anything but the real API. Browser uploads always go to https://api.cloudinary.com.
     */
    CLOUDINARY_API_URL: z
      .string()
      .trim()
      .url()
      .transform((u) => u.replace(/\/+$/, ''))
      .default('https://api.cloudinary.com'),
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
    if (env.NODE_ENV === 'production' && ['log', 'memory', 'file'].includes(env.MAIL_TRANSPORT)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'A real email provider (MAIL_TRANSPORT=resend) is required in production',
      });
    }
    if (env.NODE_ENV === 'production' && env.MAIL_ALLOWED_RECIPIENTS.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_ALLOWED_RECIPIENTS'],
        message: 'MAIL_ALLOWED_RECIPIENTS is a development safety net; remove it in production',
      });
    }
    if (env.NODE_ENV === 'production' && !env.MAIL_ENABLED_KINDS.includes('magic_link')) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_ENABLED_KINDS'],
        message:
          'MAIL_ENABLED_KINDS must include magic_link in production (members sign in by email)',
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
    if (env.NODE_ENV === 'production' && env.CLOUDINARY_API_URL !== 'https://api.cloudinary.com') {
      ctx.addIssue({
        code: 'custom',
        path: ['CLOUDINARY_API_URL'],
        message: 'CLOUDINARY_API_URL is for tests only; production uses https://api.cloudinary.com',
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
    if (
      env.NODE_ENV === 'production' &&
      env.STAFF_APP_URL_TEMPLATE !== undefined &&
      !env.STAFF_APP_URL_TEMPLATE.startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['STAFF_APP_URL_TEMPLATE'],
        message: 'STAFF_APP_URL_TEMPLATE must use https in production',
      });
    }
    {
      // A staff base must not equal a gym base (the same host would be both sites).
      if (env.MEMBER_HOST_SUFFIX && env.STAFF_BASE_DOMAINS.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['MEMBER_HOST_SUFFIX'],
          message:
            'Use either MEMBER_HOST_SUFFIX or STAFF_BASE_DOMAINS to separate member and staff addresses, not both',
        });
      }
      const overlap = env.STAFF_BASE_DOMAINS.filter((d) => env.BASE_DOMAINS.includes(d));
      if (overlap.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['STAFF_BASE_DOMAINS'],
          message: `STAFF_BASE_DOMAINS must not repeat BASE_DOMAINS: ${overlap.join(', ')}`,
        });
      }
    }
    if (env.NODE_ENV === 'production' && env.ALLOW_TENANT_HEADER) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOW_TENANT_HEADER'],
        message: 'ALLOW_TENANT_HEADER must be false in production',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      typeof env.TRUST_PROXY === 'number' &&
      env.TRUST_PROXY > 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message:
          'In production TRUST_PROXY must list the Next.js server address(es) (e.g. "uniquelocal" or "10.0.0.0/8"), not a hop count',
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
