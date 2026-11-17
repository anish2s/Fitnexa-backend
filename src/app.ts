import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import type { Env } from './config/env.js';
import type { JwtConfig } from './auth/jwt.js';
import type { Logger } from './lib/logger.js';
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
import { staffRouter } from './modules/staff/staff.routes.js';
import { gymRouter } from './modules/tenants/gym.routes.js';
import { publicTenantRouter } from './modules/tenants/public.routes.js';
import { resolveTenant, type TenantLookup } from './tenancy/resolver.middleware.js';

export interface AppDeps {
  env: Env;
  logger: Logger;
  tenantLookup: TenantLookup;
  isDbReady: () => boolean;
  mailer: Mailer;
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
  app.use(express.json({ limit: '100kb' }));

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

  const v1 = express.Router();
  v1.use('/public', publicTenantRouter());
  v1.use('/auth', authRouter({ env, jwt, auth, audit }));
  v1.use('/gym', gymRouter({ jwt, audit }));
  v1.use('/audit-logs', auditRouter({ jwt, audit }));
  v1.use('/staff', staffRouter({ jwt, auth, audit }));
  v1.use('/platform', platformRouter({ jwt, platform, audit }));
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
