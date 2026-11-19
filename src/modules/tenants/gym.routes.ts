import { Router } from 'express';
import type { JwtConfig } from '../../auth/jwt.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import type { ImageStore } from '../../lib/image-store.js';
import type { AuditService } from '../audit/audit.service.js';
import { createGymController } from './gym.controller.js';
import { brandingPatch, profilePatch } from './tenant.schemas.js';

/** /api/v1/gym — the current gym's profile, settings and branding (gym host only). */
export function gymRouter(deps: {
  jwt: JwtConfig;
  audit: AuditService;
  images: ImageStore | null;
}) {
  const c = createGymController(deps.audit, deps.images);
  const router = Router();
  const auth = authenticate(deps.jwt);

  router.get('/', auth, authorize('gym:read'), c.get);
  router.patch(
    '/',
    auth,
    authorize('gym:update'),
    validate({ body: profilePatch }),
    c.updateProfile,
  );
  router.patch(
    '/branding',
    auth,
    authorize('branding:update'),
    validate({ body: brandingPatch }),
    c.updateBranding,
  );
  return router;
}
