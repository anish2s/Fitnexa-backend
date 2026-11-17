import { Router } from 'express';
import type { JwtConfig } from '../../auth/jwt.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthService } from '../auth/auth.service.js';
import { createStaffController } from './staff.controller.js';
import * as s from './staff.schemas.js';
import { createStaffService } from './staff.service.js';

/** /api/v1/staff — the gym's team (gym host). Reading needs staff:read, changes staff:manage. */
export function staffRouter(deps: { jwt: JwtConfig; auth: AuthService; audit: AuditService }) {
  const c = createStaffController(createStaffService(deps));
  const router = Router();
  router.use(authenticate(deps.jwt));
  const byId = validate({ params: s.staffIdParams });
  const manage = authorize('staff:manage');

  router.get('/', authorize('staff:read'), validate({ query: s.staffListQuery }), c.list);
  router.post('/', manage, validate({ body: s.createStaffBody }), c.create);
  router.get('/:id', authorize('staff:read'), byId, c.get);
  router.patch(
    '/:id',
    manage,
    validate({ params: s.staffIdParams, body: s.updateStaffBody }),
    c.update,
  );
  router.post('/:id/deactivate', manage, byId, c.deactivate);
  router.post('/:id/activate', manage, byId, c.activate);
  router.post('/:id/invite', manage, byId, c.resendInvite);
  return router;
}
