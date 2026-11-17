import express, { Router } from 'express';
import type { JwtConfig } from '../../auth/jwt.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { tag } from '../../lib/route-meta.js';
import type { ImageStore } from '../../lib/image-store.js';
import type { AuditService } from '../audit/audit.service.js';
import { photoBody } from '../uploads/upload.schemas.js';
import { createMemberController } from './member.controller.js';
import * as s from './member.schemas.js';
import { createMemberImporter } from './member.import.js';
import { createMemberService } from './member.service.js';

/** /api/v1/members — front desk member management, plus /members/me for the member app. */
export function memberRouter(deps: {
  jwt: JwtConfig;
  audit: AuditService;
  images: ImageStore | null;
}) {
  const c = createMemberController(createMemberService(deps), createMemberImporter(deps));
  const router = Router();
  router.use(authenticate(deps.jwt));
  const byId = validate({ params: s.memberIdParams });

  // Before /:id so "me" is never parsed as an id.
  router.get('/me', authorize('self:read'), c.getSelf);
  router.patch('/me', authorize('self:update'), validate({ body: s.selfUpdateBody }), c.updateSelf);

  router.get('/', authorize('members:read'), validate({ query: s.memberListQuery }), c.list);
  router.post('/', authorize('members:create'), validate({ body: s.createMemberBody }), c.create);
  // Raw CSV body (a spreadsheet export), not JSON; 1 MB is ~2,000 rows with every column.
  router.post(
    '/import',
    authorize('members:import'),
    tag(express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' }), {
      kind: 'rawBody',
      contentType: 'text/csv',
    }),
    validate({ query: s.importQuery }),
    c.importCsv,
  );
  router.get('/:id', authorize('members:read'), byId, c.get);
  router.patch(
    '/:id',
    authorize('members:update'),
    validate({ params: s.memberIdParams, body: s.updateMemberBody }),
    c.update,
  );
  router.put(
    '/:id/photo',
    authorize('members:update'),
    validate({ params: s.memberIdParams, body: photoBody }),
    c.setPhoto,
  );
  router.delete('/:id/photo', authorize('members:update'), byId, c.removePhoto);
  router.post('/:id/archive', authorize('members:archive'), byId, c.archive);
  router.post('/:id/restore', authorize('members:archive'), byId, c.restore);
  return router;
}
