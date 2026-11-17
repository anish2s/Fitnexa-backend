import type { Request, Response } from 'express';
import { created, ok } from '../../lib/response.js';
import { auditContextFrom } from '../audit/audit.service.js';
import type { ClientMeta } from '../auth/auth.service.js';
import type { CreateStaffInput, StaffListQuery, UpdateStaffInput } from './staff.schemas.js';
import type { StaffService } from './staff.service.js';

export function createStaffController(staff: StaffService) {
  const idOf = (req: Request) => (req.valid.params as { id: string }).id;
  const meta = (req: Request): ClientMeta => ({
    ip: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.id === undefined ? undefined : String(req.id),
  });

  return {
    async list(req: Request, res: Response) {
      const { items, meta: page } = await staff.list(req.valid.query as StaffListQuery);
      ok(res, items, 200, { ...page });
    },
    async get(req: Request, res: Response) {
      ok(res, await staff.get(idOf(req)));
    },
    async create(req: Request, res: Response) {
      created(
        res,
        await staff.create(
          req.tenant!,
          req.valid.body as CreateStaffInput,
          auditContextFrom(req),
          meta(req),
        ),
      );
    },
    async update(req: Request, res: Response) {
      ok(
        res,
        await staff.update(idOf(req), req.valid.body as UpdateStaffInput, auditContextFrom(req)),
      );
    },
    async deactivate(req: Request, res: Response) {
      ok(res, await staff.deactivate(idOf(req), auditContextFrom(req)));
    },
    async activate(req: Request, res: Response) {
      ok(res, await staff.activate(idOf(req), auditContextFrom(req)));
    },
    async resendInvite(req: Request, res: Response) {
      ok(
        res,
        await staff.resendInvite(req.tenant!, idOf(req), auditContextFrom(req), meta(req)),
        202,
      );
    },
  };
}
