import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import type { Env } from './config/env.js';
import type { JwtConfig } from './auth/jwt.js';
import type { Logger } from './lib/logger.js';
import { buildOpenApi, type MountedRouter } from './openapi/generate.js';
import { PACKAGE_VERSION } from './openapi/assets.js';
import { openApiRouter, swaggerUiRouter } from './openapi/docs.routes.js';
import { createImageStore, type ImageStore } from './lib/image-store.js';
import type { Mailer } from './lib/mailer.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { attendanceRouters } from './modules/attendance/attendance.routes.js';
import { createPassSigner, qrMasterSecret } from './modules/attendance/qr-pass.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { createAuditService } from './modules/audit/audit.service.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { healthRouter } from './modules/health/health.routes.js';
import { platformRouter } from './modules/platform/platform.routes.js';
import { createPlatformService } from './modules/platform/platform.service.js';
import { memberRouter } from './modules/members/member.routes.js';
import { membershipRouters } from './modules/memberships/membership.routes.js';
import { paymentRouters } from './modules/payments/payment.routes.js';
import { gatewayRouters } from './modules/payments/gateway.routes.js';
import { createGatewayService } from './modules/payments/gateway.service.js';
import { httpRazorpayClient, type RazorpayClient } from './modules/payments/razorpay.client.js';
import { planRouter } from './modules/plans/plan.routes.js';
import { notificationRouter } from './modules/notifications/notification.routes.js';
import { createNotificationService } from './modules/notifications/notification.service.js';
import { reportRouters } from './modules/reports/report.routes.js';
import { whatsappRouter } from './modules/whatsapp/whatsapp.routes.js';
import { privacyRouter } from './modules/privacy/privacy.routes.js';
import { staffRouter } from './modules/staff/staff.routes.js';
import { uploadRouter } from './modules/uploads/upload.routes.js';
import { gymRouter } from './modules/tenants/gym.routes.js';
import { publicTenantRouter } from './modules/tenants/public.routes.js';
import { resolveTenant, type TenantLookup } from './tenancy/resolver.middleware.js';

export interface AppDeps {
  env: Env;
  logger: Logger;
  tenantLookup: TenantLookup;
  isDbReady: () => boolean;
  mailer: Mailer;
  /** Razorpay HTTP client; tests inject a fake. */
  razorpay?: RazorpayClient;
  /** Defaults to Cloudinary from env; `null` = uploads not configured. Tests inject a fake. */
  images?: ImageStore | null;
}

/**
 * Builds the Express app. Dependencies are injected so tests can swap the tenant lookup,
 * mailer and database readiness check.
 *
 * Pipeline order (matches the architecture doc):
 *   security headers → request id/logging → CORS → rate limit → body parsing
 *   → tenant resolution → [auth → RBAC → validation → service] → 404 → error handler
 */
const SAFE_QUERY_KEYS = new Set([
  'page',
  'limit',
  'status',
  'sort',
  'groupBy',
  'from',
  'to',
  'date',
  'days',
  'template',
  'kind',
  'method',
  'archived',
  'due',
  'dryRun',
  'consentConfirmed',
  'role',
  'action',
  'purpose',
]);

/** `/members?q=98111&page=2` → `/members?q=[redacted]&page=2` */
export function redactQuery(url: string): string {
  const i = url.indexOf('?');
  if (i < 0) return url;
  const params = new URLSearchParams(url.slice(i + 1));
  const parts = [...params.keys()].map((k) =>
    SAFE_QUERY_KEYS.has(k) ? `${k}=${encodeURIComponent(params.get(k) ?? '')}` : `${k}=[redacted]`,
  );
  return `${url.slice(0, i)}?${parts.join('&')}`;
}

export function createApp(deps: AppDeps) {
  const { env, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple'); // no nested-object query parsing (blocks ?a[$ne]=x tricks)

  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
      // Query strings can carry personal data (member search, WhatsApp text): log values only for
      // known-safe parameters. Headers are left out entirely (tokens/cookies are redacted anyway).
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: redactQuery(req.url),
        }),
      },
    }),
  );
  app.use(corsMiddleware(env.CORS_ORIGINS));

  // Health checks bypass rate limiting and tenant resolution.
  const health = healthRouter(deps.isDbReady);
  app.use(health);

  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (req, res) =>
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests, slow down',
            requestId: req.id,
          },
        }),
    }),
  );
  app.use(
    express.json({
      limit: '100kb',
      // Webhook signatures are over the exact bytes received, not the re-serialised JSON.
      verify: (req, _res, buf) => {
        const r = req as express.Request;
        if (r.originalUrl?.startsWith('/api/v1/webhooks/')) r.rawBody = Buffer.from(buf);
      },
    }),
  );

  app.use(
    resolveTenant({
      lookup: deps.tenantLookup,
      baseDomains: env.BASE_DOMAINS,
      reservedSubdomains: env.RESERVED_SUBDOMAINS,
      allowTenantHeader: env.ALLOW_TENANT_HEADER,
    }),
  );

  const jwt: JwtConfig = {
    secret: env.JWT_ACCESS_SECRET,
    issuer: env.JWT_ISSUER,
    ttlSec: env.ACCESS_TOKEN_TTL_SEC,
  };
  const audit = createAuditService({ logger });
  const auth = createAuthService({ env, mailer: deps.mailer, logger, audit });
  const platform = createPlatformService({ env, auth, audit, logger });
  const images = deps.images === undefined ? createImageStore(env, logger) : deps.images;

  const v1 = express.Router();
  /** Every router mounted under /api/v1, recorded for the OpenAPI document and the route audit. */
  const mounts: MountedRouter[] = [];
  // API responses carry personal and financial data: never cached unless a route opts in
  // (public branding, the OpenAPI document).
  v1.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const mount = (path: string, router: express.Router) => {
    mounts.push({ base: '/api/v1', path, router });
    v1.use(path, router);
  };
  mount('/public', publicTenantRouter());
  mount('/auth', authRouter({ env, jwt, auth, audit }));
  mount('/gym', gymRouter({ jwt, audit }));
  mount('/audit-logs', auditRouter({ jwt, audit }));
  mount('/staff', staffRouter({ jwt, auth, audit }));
  const ms = membershipRouters({ jwt, audit, env });
  const gateway = createGatewayService({
    env,
    audit,
    logger,
    razorpay: deps.razorpay ?? httpRazorpayClient(),
  });
  const gw = gatewayRouters({ jwt, gateway });
  const pay = paymentRouters({ jwt, audit, gateway });
  mount('/members', ms.perMember);
  mount('/members', whatsappRouter({ jwt, env }));
  mount('/members', privacyRouter({ jwt, audit, images, logger }));
  const att = attendanceRouters({ jwt, passes: createPassSigner(qrMasterSecret(env)) });
  mount('/members', att.perMember);
  mount('/attendance', att.attendance);
  mount('/members', pay.perMember);
  mount('/members', gw.memberOrders);
  mount('/members', memberRouter({ jwt, audit, images }));
  mount('/memberships', pay.perMembership);
  mount('/memberships', gw.deskOrders);
  mount('/memberships', ms.memberships);
  mount('/payments', gw.verify);
  mount('/payments', pay.payments);
  mount('/gym/payment-gateway', gw.settings);
  mount('/webhooks', gw.webhooks);
  const rep = reportRouters({ jwt });
  mount('/dashboard', rep.dashboard);
  mount('/reports', rep.reports);
  mount(
    '/notifications',
    notificationRouter({
      jwt,
      notifications: createNotificationService({ env, mailer: deps.mailer, logger, audit }),
    }),
  );
  mount('/uploads', uploadRouter({ jwt, images }));
  mount('/plans', planRouter({ jwt, audit }));
  mount('/platform', platformRouter({ jwt, platform, audit }));
  mounts.unshift({ base: '', path: '', router: health });
  app.locals.mounts = mounts;

  // The API contract for gym-saas-web (it generates its client types from this). Built once, lazily.
  let spec: ReturnType<typeof buildOpenApi> | undefined;
  const contract = openApiRouter(
    () => (spec ??= buildOpenApi(mounts, { version: PACKAGE_VERSION })),
  );
  v1.use(contract);
  // Routes that are not part of the documented API but must still pass the route audit.
  const unlisted: MountedRouter[] = [{ base: '/api/v1', path: '', router: contract }];
  app.use('/api/v1', v1);
  if (env.NODE_ENV !== 'production' || env.ENABLE_API_DOCS) {
    const ui = swaggerUiRouter();
    app.use('/api/docs', ui);
    unlisted.push({ base: '/api/docs', path: '', router: ui });
  }
  app.locals.unlisted = unlisted;

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
