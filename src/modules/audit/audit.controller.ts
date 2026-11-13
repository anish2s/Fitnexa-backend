import type { Request, Response } from 'express';
import { ok } from '../../lib/response.js';
import type { AuditListFilter, AuditService } from './audit.service.js';

export function createAuditController(audit: AuditService) {
  return {
    async list(req: Request, res: Response) {
      const { items, meta } = await audit.listForCurrentTenant(req.valid.query as AuditListFilter);
      res.set('Cache-Control', 'no-store');
      ok(res, items, 200, { ...meta });
    },
  };
}
