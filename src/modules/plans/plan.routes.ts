import { Router } from 'express';
import type { JwtConfig } from '../../auth/jwt.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import type { AuditService } from '../audit/audit.service.js';
import { createPlanController } from './plan.controller.js';
import * as s from './plan.schemas.js';
import { createPlanService } from './plan.service.js';

/** /api/v1/plans — reading needs plans:read (owner, staff); changes need plans:manage. */
export function planRouter(deps: { jwt: JwtConfig; audit: AuditService }) {
  const c = createPlanController(createPlanService(deps));
  const router = Router();
  router.use(authenticate(deps.jwt));
  const byId = validate({ params: s.planIdParams });
  const manage = authorize('plans:manage');

  router.get('/', authorize('plans:read'), validate({ query: s.planListQuery }), c.list);
  router.post('/', manage, validate({ body: s.createPlanBody }), c.create);
  router.get('/:id', authorize('plans:read'), byId, c.get);
  router.patch(
    '/:id',
    manage,
    validate({ params: s.planIdParams, body: s.updatePlanBody }),
    c.update,
  );
  router.post('/:id/archive', manage, byId, c.archive);
  router.post('/:id/restore', manage, byId, c.restore);
  return router;
}
