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
import { idempotencyKeyOf } from '../payments/payment.controller.js';

export function createMembershipController(svc: MembershipService) {
  const idOf = (req: Request) => (req.valid.params as { id: string }).id;
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store');
  const send = (res: Response, r: { membership: unknown; replayed: boolean }) => {
    if (r.replayed) res.set('Idempotent-Replayed', 'true');
    return r.replayed ? ok(res, r.membership) : created(res, r.membership);
  };
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
      const body = req.valid.body as SellInput;
      const key = body.payment ? idempotencyKeyOf(req) : undefined;
      send(res, await svc.create(idOf(req), body, auditContextFrom(req), key));
    },
    async renew(req: Request, res: Response) {
      const body = req.valid.body as RenewInput;
      const key = body.payment ? idempotencyKeyOf(req) : undefined;
      send(res, await svc.renew(idOf(req), body, auditContextFrom(req), key));
    },
    async selfHistory(req: Request, res: Response) {
      noStore(res);
      ok(res, await svc.selfHistory(req.auth!.userId));
    },
  };
}
