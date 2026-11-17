import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { JwtConfig } from '../../auth/jwt.js';
import type { ImageStore } from '../../lib/image-store.js';
import type { Logger } from '../../lib/logger.js';
import { ok } from '../../lib/response.js';
import { authenticate, authorize, notWhileImpersonating } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { auditContextFrom, type AuditService } from '../audit/audit.service.js';
import { memberIdParams } from '../members/member.schemas.js';
import { createPrivacyService } from './privacy.service.js';

const eraseBody = z.object({
  /** Typed by the owner: proves they mean this member. */
  confirmMemberCode: z.string().trim().min(2).max(20),
  reason: z.string().trim().min(5).max(500),
});

/** DPDP: /members/:id/export, /members/:id/erase (owner), /members/me/export (the member). */
export function privacyRouter(deps: {
  jwt: JwtConfig;
  audit: AuditService;
  images: ImageStore | null;
  logger: Logger;
}) {
  const svc = createPrivacyService(deps);
  const auth = authenticate(deps.jwt);
  const router = Router();

  const sendJson = (res: Response, code: string, data: unknown) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="member-${code}-data.json"`,
    });
    ok(res, data);
  };

  router.get('/me/export', auth, authorize('self:read'), async (req: Request, res: Response) => {
    const data = await svc.exportSelf(req.auth!.userId, auditContextFrom(req));
    sendJson(res, data.member.memberCode, data);
  });
  router.get(
    '/:id/export',
    auth,
    authorize('privacy:manage'),
    validate({ params: memberIdParams }),
    async (req: Request, res: Response) => {
      const data = await svc.exportMember(
        (req.valid.params as { id: string }).id,
        auditContextFrom(req),
      );
      sendJson(res, data.member.memberCode, data);
    },
  );
  router.post(
    '/:id/erase',
    auth,
    authorize('privacy:manage'),
    notWhileImpersonating,
    validate({ params: memberIdParams, body: eraseBody }),
    async (req: Request, res: Response) => {
      ok(
        res,
        await svc.erase(
          (req.valid.params as { id: string }).id,
          req.valid.body as z.infer<typeof eraseBody>,
          auditContextFrom(req),
        ),
      );
    },
  );
  return router;
}
