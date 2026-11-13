import { Router, type RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Env } from '../../config/env.js';
import type { JwtConfig } from '../../auth/jwt.js';
import { authenticate, notWhileImpersonating } from '../../middleware/authenticate.js';
import { sameOriginOnly } from '../../middleware/same-origin.js';
import { validate } from '../../middleware/validate.js';
import { createAuthController } from './auth.controller.js';
import * as s from './auth.schemas.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthService } from './auth.service.js';

/**
 * /api/v1/auth
 *
 * On a gym host (powerhouse.yourapp.in): owners/staff (password) and members (email link).
 * On the platform host (admin.yourapp.in): super admins (password). Email-link and reset
 * endpoints exist only on gym hosts.
 */
export function authRouter(deps: {
  env: Env;
  jwt: JwtConfig;
  auth: AuthService;
  audit: AuditService;
}) {
  const { env } = deps;
  const c = createAuthController(env, deps.auth, deps.audit);
  const router = Router();
  const requireAuth = authenticate(deps.jwt);
  const sameOrigin = sameOriginOnly(env.CORS_ORIGINS);

  const limited = (field: 'identifier' | 'email' | 'token'): RequestHandler[] => {
    const scope = (req: Parameters<RequestHandler>[0]) => req.tenant?.slug ?? 'platform';
    const handler: Parameters<typeof rateLimit>[0] = {
      windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (req, res) =>
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many attempts. Please wait and try again.',
            requestId: req.id,
          },
        }),
    };
    return [
      // Per IP + gym: stops one machine spraying many accounts.
      rateLimit({
        ...handler,
        limit: env.AUTH_RATE_LIMIT_MAX * 3,
        keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}|${scope(req)}|${field}`,
      }),
      // Per IP + gym + account: stops guessing one account's password.
      rateLimit({
        ...handler,
        limit: env.AUTH_RATE_LIMIT_MAX,
        keyGenerator: (req) => {
          const raw = (req.body as Record<string, unknown> | undefined)?.[field];
          const id = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 254) : '';
          return `${ipKeyGenerator(req.ip ?? '')}|${scope(req)}|${field}|${id}`;
        },
      }),
    ];
  };

  router.post('/login', ...limited('identifier'), validate({ body: s.loginBody }), c.login);

  router.post(
    '/magic-link',
    ...limited('email'),
    validate({ body: s.magicLinkBody }),
    c.requestMagicLink,
  );
  router.post(
    '/magic-link/verify',
    ...limited('token'),
    validate({ body: s.verifyLinkBody }),
    c.verifyMagicLink,
  );

  router.post(
    '/password/forgot',
    ...limited('email'),
    validate({ body: s.forgotBody }),
    c.forgotPassword,
  );
  router.post(
    '/password/reset',
    ...limited('token'),
    validate({ body: s.resetBody }),
    c.resetPassword,
  );
  router.post(
    '/password/change',
    requireAuth,
    notWhileImpersonating,
    validate({ body: s.changePasswordBody }),
    c.changePassword,
  );

  router.post('/refresh', sameOrigin, c.refresh);
  router.post('/logout', sameOrigin, c.logout);
  router.post('/logout-all', requireAuth, notWhileImpersonating, c.logoutAll);
  router.post('/impersonation/end', requireAuth, c.endImpersonation);

  router.get('/me', requireAuth, c.me);
  router.get('/sessions', requireAuth, c.listSessions);
  router.delete(
    '/sessions/:id',
    requireAuth,
    notWhileImpersonating,
    validate({ params: s.sessionIdParams }),
    c.revokeSession,
  );

  return router;
}
