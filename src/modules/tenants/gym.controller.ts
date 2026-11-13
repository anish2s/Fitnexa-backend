import type { Request, Response } from 'express';
import { ok } from '../../lib/response.js';
import { auditContextFrom, type AuditService } from '../audit/audit.service.js';
import { getTenantView, patchTenant } from './tenant.service.js';

/**
 * The signed-in owner's own gym. The gym is ALWAYS the host's gym (req.tenant), never an id from
 * the request, so there is nothing to tamper with.
 */
export function createGymController(audit: AuditService) {
  async function update(req: Request, res: Response, kind: 'profile' | 'branding') {
    const tenantId = req.tenant!.id;
    const patch = req.valid.body as Record<string, unknown>;
    const { tenant, changes } = await patchTenant(
      tenantId,
      kind === 'branding' ? { branding: patch } : patch,
    );
    if (changes.length) {
      await audit.record(auditContextFrom(req), {
        action: kind === 'branding' ? 'gym.branding_update' : 'gym.update',
        target: { type: 'tenant', id: String(tenantId) },
        changes,
      });
    }
    ok(res, tenant);
  }

  return {
    async get(req: Request, res: Response) {
      res.set('Cache-Control', 'no-store');
      ok(res, await getTenantView(req.tenant!.id));
    },
    updateProfile: (req: Request, res: Response) => update(req, res, 'profile'),
    updateBranding: (req: Request, res: Response) => update(req, res, 'branding'),
  };
}
