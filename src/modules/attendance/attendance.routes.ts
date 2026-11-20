import { Router, type Request, type Response } from 'express';
import type { JwtConfig } from '../../auth/jwt.js';
import { created, ok } from '../../lib/response.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { auditContextFrom } from '../audit/audit.service.js';
import { memberIdParams } from '../members/member.schemas.js';
import * as s from './attendance.schemas.js';
import { createAttendanceService } from './attendance.service.js';
import type { PassSigner } from './qr-pass.js';

/**
 * /api/v1/attendance                 desk: scan, manual, today's list, daily report
 * /api/v1/members/:id/attendance     one member's visits (staff)
 * /api/v1/members/me/pass|attendance|stats member app: QR pass, own visits, streak/month/badges
 */
export function attendanceRouters(deps: { jwt: JwtConfig; passes: PassSigner }) {
  const svc = createAttendanceService(deps);
  const auth = authenticate(deps.jwt);
  const read = authorize('attendance:read');
  const checkin = authorize('attendance:checkin');
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store');

  // 201 for a new check-in, 200 for "already checked in today".
  const sendCheckIn = (res: Response, r: { status: string }) =>
    r.status === 'checked_in' ? created(res, r) : ok(res, r);

  const attendance = Router();
  attendance.post(
    '/scan',
    auth,
    checkin,
    validate({ body: s.scanBody }),
    async (req: Request, res: Response) => {
      const { token } = req.valid.body as { token: string };
      sendCheckIn(res, await svc.scan(token, auditContextFrom(req)));
    },
  );
  attendance.post(
    '/manual',
    auth,
    checkin,
    validate({ body: s.manualBody }),
    async (req: Request, res: Response) => {
      const { memberId } = req.valid.body as { memberId: string };
      sendCheckIn(res, await svc.checkIn(memberId, 'manual', auditContextFrom(req)));
    },
  );
  attendance.get(
    '/',
    auth,
    read,
    validate({ query: s.dayQuery }),
    async (req: Request, res: Response) => {
      const { items, meta } = await svc.forDay(req.valid.query as s.DayQuery);
      noStore(res);
      ok(res, items, 200, { ...meta });
    },
  );
  attendance.get(
    '/report',
    auth,
    read,
    validate({ query: s.reportQuery }),
    async (req: Request, res: Response) => {
      noStore(res);
      ok(res, await svc.report((req.valid.query as { date?: string }).date));
    },
  );

  const perMember = Router();
  perMember.get('/me/pass', auth, authorize('self:read'), async (req: Request, res: Response) => {
    noStore(res);
    ok(res, await svc.issuePass(req.auth!.userId));
  });
  perMember.get('/me/stats', auth, authorize('self:read'), async (req: Request, res: Response) => {
    noStore(res);
    ok(res, await svc.selfStats(req.auth!.userId));
  });
  perMember.get(
    '/me/attendance',
    auth,
    authorize('self:read'),
    validate({ query: s.rangeQuery }),
    async (req: Request, res: Response) => {
      const { items, meta } = await svc.selfHistory(
        req.auth!.userId,
        req.valid.query as s.RangeQuery,
      );
      noStore(res);
      ok(res, items, 200, { ...meta });
    },
  );
  perMember.get(
    '/:id/attendance',
    auth,
    read,
    validate({ params: memberIdParams, query: s.rangeQuery }),
    async (req: Request, res: Response) => {
      const { id } = req.valid.params as { id: string };
      const { items, meta } = await svc.memberHistory(id, req.valid.query as s.RangeQuery);
      noStore(res);
      ok(res, items, 200, { ...meta });
    },
  );

  return { attendance, perMember };
}
