import type { Request, Response } from 'express';
import { created, ok } from '../../lib/response.js';
import { auditContextFrom } from '../audit/audit.service.js';
import type {
  ExpiringQuery,
  MembershipListQuery,
  RenewInput,
  SellInput,
} from './membership.schemas.js';
import type { MembershipService } from './membership.service.js';

export function createMembershipController(svc: MembershipService) {
  const idOf = (req: Request) => (req.valid.params as { id: string }).id;
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store');
  return {
    async list(req: Request, res: Response) {
      const { items, meta } = await svc.list(req.valid.query as MembershipListQuery);
      noStore(res);
      ok(res, items, 200, { ...meta });
    },
    async expiring(req: Request, res: Response) {
      const { items, meta } = await svc.expiring(req.valid.query as ExpiringQuery);
      noStore(res);
      ok(res, items, 200, { ...meta });
    },
    async cancel(req: Request, res: Response) {
      const { reason } = req.valid.body as { reason: string };
      ok(res, await svc.cancel(idOf(req), reason, auditContextFrom(req)));
    },
    async history(req: Request, res: Response) {
      noStore(res);
      ok(res, await svc.history(idOf(req)));
    },
    async create(req: Request, res: Response) {
      created(res, await svc.create(idOf(req), req.valid.body as SellInput, auditContextFrom(req)));
    },
    async renew(req: Request, res: Response) {
      created(res, await svc.renew(idOf(req), req.valid.body as RenewInput, auditContextFrom(req)));
    },
    async selfHistory(req: Request, res: Response) {
      noStore(res);
      ok(res, await svc.selfHistory(req.auth!.userId));
    },
  };
}
