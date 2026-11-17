import { Router, type Request, type Response } from 'express';
import type { JwtConfig } from '../../auth/jwt.js';
import { ok } from '../../lib/response.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { rangeQuery, type RangeQuery } from './report.schemas.js';
import { createReportService } from './report.service.js';

/**
 * /api/v1/dashboard   home-screen KPIs (dashboard:read: owner and front desk; revenue only with reports:read)
 * /api/v1/reports/*   date-range reports (reports:read: owner, grantable to staff)
 */
export function reportRouters(deps: { jwt: JwtConfig }) {
  const svc = createReportService();
  const auth = authenticate(deps.jwt);

  const dashboard = Router();
  dashboard.get('/', auth, authorize('dashboard:read'), async (req: Request, res: Response) => {
    const a = req.auth!;
    const includeRevenue = a.kind === 'tenant' && a.permissions.has('reports:read');
    const includeAlerts = a.kind === 'tenant' && a.permissions.has('payments:refund');
    res.set('Cache-Control', 'no-store');
    ok(res, await svc.dashboard({ includeRevenue, includeAlerts }));
  });

  const reports = Router();
  for (const name of ['revenue', 'memberships', 'attendance', 'growth', 'renewals'] as const) {
    reports.get(
      `/${name}`,
      auth,
      authorize('reports:read'),
      validate({ query: rangeQuery }),
      async (req: Request, res: Response) => {
        res.set('Cache-Control', 'no-store');
        ok(res, await svc[name](req.valid.query as RangeQuery));
      },
    );
  }
  return { dashboard, reports };
}
