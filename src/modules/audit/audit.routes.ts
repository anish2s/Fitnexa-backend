import { Router } from 'express';
import type { JwtConfig } from '../../auth/jwt.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { createAuditController } from './audit.controller.js';
import { auditListQuery } from './audit.schemas.js';
import type { AuditService } from './audit.service.js';

/** /api/v1/audit-logs — the gym's own audit log (owners; includes super-admin actions on the gym). */
export function auditRouter(deps: { jwt: JwtConfig; audit: AuditService }) {
  const c = createAuditController(deps.audit);
  const router = Router();
  router.get(
    '/',
    authenticate(deps.jwt),
    authorize('audit:read'),
    validate({ query: auditListQuery }),
    c.list,
  );
  return router;
}
