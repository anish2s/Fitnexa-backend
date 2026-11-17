import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { JwtConfig } from '../../auth/jwt.js';
import { objectId, pageQuery } from '../../lib/pagination.js';
import { ok } from '../../lib/response.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { auditContextFrom } from '../audit/audit.service.js';
import { NOTIFICATION_KINDS, NOTIFICATION_STATUSES } from './notification.model.js';
import type { NotificationService } from './notification.service.js';

const listQuery = pageQuery.extend({
  status: z.enum(NOTIFICATION_STATUSES).optional(),
  kind: z.enum(NOTIFICATION_KINDS).optional(),
});
const idParams = z.object({ id: objectId });

/** /api/v1/notifications — the reminder queue (renewals:manage: owner, grantable). */
export function notificationRouter(deps: { jwt: JwtConfig; notifications: NotificationService }) {
  const n = deps.notifications;
  const router = Router();
  router.use(authenticate(deps.jwt), authorize('renewals:manage'));
  router.get('/', validate({ query: listQuery }), async (req: Request, res: Response) => {
    const { items, meta } = await n.list(req.valid.query as z.infer<typeof listQuery>);
    res.set('Cache-Control', 'no-store');
    ok(res, items, 200, { ...meta });
  });
  router.post('/:id/retry', validate({ params: idParams }), async (req: Request, res: Response) => {
    ok(res, await n.retry((req.valid.params as { id: string }).id, auditContextFrom(req)));
  });
  router.post(
    '/:id/cancel',
    validate({ params: idParams }),
    async (req: Request, res: Response) => {
      ok(res, await n.cancel((req.valid.params as { id: string }).id, auditContextFrom(req)));
    },
  );
  return router;
}
