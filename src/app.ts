import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import type { Env } from './config/env.js';
import type { JwtConfig } from './auth/jwt.js';
import type { Logger } from './lib/logger.js';
import { createImageStore, type ImageStore } from './lib/image-store.js';
import type { Mailer } from './lib/mailer.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
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
    }),
  );
  app.use(corsMiddleware(env.CORS_ORIGINS));

  // Health checks bypass rate limiting and tenant resolution.
  app.use(healthRouter(deps.isDbReady));

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
  v1.use('/public', publicTenantRouter());
  v1.use('/auth', authRouter({ env, jwt, auth, audit }));
  v1.use('/gym', gymRouter({ jwt, audit }));
  v1.use('/audit-logs', auditRouter({ jwt, audit }));
  v1.use('/staff', staffRouter({ jwt, auth, audit }));
  const ms = membershipRouters({ jwt, audit });
  const gateway = createGatewayService({
    env,
    audit,
    logger,
    razorpay: deps.razorpay ?? httpRazorpayClient(),
  });
  const gw = gatewayRouters({ jwt, gateway });
  const pay = paymentRouters({ jwt, audit, gateway });
  v1.use('/members', ms.perMember);
  v1.use('/members', pay.perMember);
  v1.use('/members', gw.memberOrders);
  v1.use('/members', memberRouter({ jwt, audit, images }));
  v1.use('/memberships', pay.perMembership);
  v1.use('/memberships', gw.deskOrders);
  v1.use('/memberships', ms.memberships);
  v1.use('/payments', gw.verify);
  v1.use('/payments', pay.payments);
  v1.use('/gym/payment-gateway', gw.settings);
  v1.use('/webhooks', gw.webhooks);
  v1.use('/uploads', uploadRouter({ jwt, images }));
  v1.use('/plans', planRouter({ jwt, audit }));
  v1.use('/platform', platformRouter({ jwt, platform, audit }));
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
