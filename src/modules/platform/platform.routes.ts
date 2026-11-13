import { Router } from 'express';
import type { JwtConfig } from '../../auth/jwt.js';
import { authenticate, requirePlatformAdmin } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { auditListQuery } from '../audit/audit.schemas.js';
import type { AuditService } from '../audit/audit.service.js';
import { createPlatformController } from './platform.controller.js';
import * as s from './platform.schemas.js';
import type { PlatformService } from './platform.service.js';

/**
 * /api/v1/platform — super admin console. Platform host only: platform tokens are refused on gym
 * hosts by authenticate(), and gym tokens are refused here by requirePlatformAdmin.
 */
export function platformRouter(deps: {
  jwt: JwtConfig;
  platform: PlatformService;
  audit: AuditService;
}) {
  const c = createPlatformController(deps.platform, deps.audit);
  const router = Router();
  router.use(authenticate(deps.jwt), requirePlatformAdmin);

  const byId = validate({ params: s.tenantIdParams });

  router.get('/tenants', validate({ query: s.tenantListQuery }), c.list);
  router.get('/tenants/slug-availability', validate({ query: s.slugQuery }), c.slugAvailability);
  router.post('/tenants', validate({ body: s.createTenantBody }), c.create);
  router.get('/tenants/:id', byId, c.get);
  router.patch(
    '/tenants/:id',
    validate({ params: s.tenantIdParams, body: s.platformTenantPatch }),
    c.update,
  );
  router.patch(
    '/tenants/:id/branding',
    validate({ params: s.tenantIdParams, body: s.platformBrandingPatch }),
    c.updateBranding,
  );
  router.post(
    '/tenants/:id/suspend',
    validate({ params: s.tenantIdParams, body: s.suspendBody }),
    c.suspend,
  );
  router.post('/tenants/:id/activate', byId, c.activate);
  router.post('/tenants/:id/owner-invite', byId, c.resendInvite);
  router.post(
    '/tenants/:id/impersonate',
    validate({ params: s.tenantIdParams, body: s.impersonateBody }),
    c.impersonate,
  );
  router.get(
    '/tenants/:id/audit-logs',
    validate({ params: s.tenantIdParams, query: auditListQuery }),
    c.tenantAuditLogs,
  );
  router.get('/audit-logs', validate({ query: auditListQuery }), c.platformAuditLogs);
  return router;
}
