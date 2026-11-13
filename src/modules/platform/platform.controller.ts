import type { Request, Response } from 'express';
import { created, ok } from '../../lib/response.js';
import {
  auditContextFrom,
  type AuditListFilter,
  type AuditService,
} from '../audit/audit.service.js';
import type { ClientMeta } from '../auth/auth.service.js';
import type { CreateTenantInput } from './platform.schemas.js';
import type { PlatformService } from './platform.service.js';

/** HTTP in/out for the super admin console. Business rules live in platform.service.ts. */
export function createPlatformController(platform: PlatformService, audit: AuditService) {
  const idOf = (req: Request) => (req.valid.params as { id: string }).id;
  const meta = (req: Request): ClientMeta => ({
    ip: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.id === undefined ? undefined : String(req.id),
  });

  return {
    async list(req: Request, res: Response) {
      const { items, meta: page } = await platform.listTenants(
        req.valid.query as Parameters<PlatformService['listTenants']>[0],
      );
      ok(res, items, 200, { ...page });
    },

    async slugAvailability(req: Request, res: Response) {
      const { slug } = req.valid.query as { slug: string };
      ok(res, await platform.slugAvailability(slug));
    },

    async create(req: Request, res: Response) {
      const body = req.valid.body as CreateTenantInput;
      created(res, await platform.createTenant(body, auditContextFrom(req), meta(req)));
    },

    async get(req: Request, res: Response) {
      res.set('Cache-Control', 'no-store');
      ok(res, await platform.getTenant(idOf(req)));
    },

    async update(req: Request, res: Response) {
      const patch = req.valid.body as Record<string, unknown>;
      ok(res, await platform.updateTenant(idOf(req), patch, auditContextFrom(req), 'profile'));
    },

    async updateBranding(req: Request, res: Response) {
      const patch = req.valid.body as Record<string, unknown>;
      ok(res, await platform.updateTenant(idOf(req), patch, auditContextFrom(req), 'branding'));
    },

    async suspend(req: Request, res: Response) {
      const { reason } = req.valid.body as { reason: string };
      ok(res, await platform.suspend(idOf(req), reason, auditContextFrom(req)));
    },

    async activate(req: Request, res: Response) {
      ok(res, await platform.activate(idOf(req), auditContextFrom(req)));
    },

    async resendInvite(req: Request, res: Response) {
      ok(res, await platform.resendOwnerInvite(idOf(req), auditContextFrom(req), meta(req)), 202);
    },

    async impersonate(req: Request, res: Response) {
      const { reason } = req.valid.body as { reason: string };
      res.set('Cache-Control', 'no-store');
      created(res, await platform.impersonate(idOf(req), reason, auditContextFrom(req), meta(req)));
    },

    async tenantAuditLogs(req: Request, res: Response) {
      const tenantId = await platform.ensureExists(idOf(req));
      const { items, meta: page } = await audit.listForTenant(
        tenantId,
        req.valid.query as AuditListFilter,
      );
      res.set('Cache-Control', 'no-store');
      ok(res, items, 200, { ...page });
    },

    async platformAuditLogs(req: Request, res: Response) {
      const { items, meta: page } = await audit.listPlatform(req.valid.query as AuditListFilter);
      res.set('Cache-Control', 'no-store');
      ok(res, items, 200, { ...page });
    },
  };
}
