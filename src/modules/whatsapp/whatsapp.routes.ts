import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { JwtConfig } from '../../auth/jwt.js';
import { parseDateOnly } from '../../lib/dates.js';
import { Errors } from '../../lib/errors.js';
import { ok } from '../../lib/response.js';
import { requireTenantId } from '../../tenancy/context.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { Member } from '../members/member.model.js';
import { memberIdParams } from '../members/member.schemas.js';
import { gymCalendar, membershipSummary } from '../memberships/membership.service.js';
import { Tenant } from '../tenants/tenant.model.js';
import { TEMPLATES, messageFor, waLink, type Template } from './whatsapp.js';

const query = z
  .object({
    template: z.enum(TEMPLATES),
    /** Only for template=custom. */
    text: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((q) => q.template !== 'custom' || q.text, {
    message: 'text is required for a custom message',
    path: ['text'],
  });

/** Context for templates: gym, member, and the member's current (or latest) membership. */
export async function whatsappContext(env: Env, memberId: string) {
  const [gym, member] = await Promise.all([
    Tenant.findById(requireTenantId()).select('name slug').lean(),
    Member.findById(memberId).select('name memberCode phone archivedAt').lean(),
  ]);
  if (!member) throw Errors.notFound('Member');
  if (!member.phone) throw Errors.conflict('This member has no phone number');
  const { today } = await gymCalendar();
  const s = await membershipSummary(member._id, today);
  const cur = s.current;
  return {
    phone: member.phone,
    ctx: {
      gymName: gym!.name,
      appUrl: env.GYM_APP_URL_TEMPLATE.replace('{slug}', gym!.slug),
      memberName: member.name,
      memberCode: member.memberCode,
      membership: cur
        ? {
            plan: cur.plan.name,
            endDate: cur.endDate!,
            ended: parseDateOnly(cur.endDate!)! < today,
            balancePaise: cur.balancePaise,
          }
        : null,
    },
  };
}

/** GET /api/v1/members/:id/whatsapp — a wa.me link with a ready message (members:read). */
export function whatsappRouter(deps: { jwt: JwtConfig; env: Env }) {
  const router = Router();
  router.get(
    '/:id/whatsapp',
    authenticate(deps.jwt),
    authorize('members:read'),
    validate({ params: memberIdParams, query }),
    async (req: Request, res: Response) => {
      const { id } = req.valid.params as { id: string };
      const q = req.valid.query as { template: Template; text?: string };
      const { phone, ctx } = await whatsappContext(deps.env, id);
      const text = q.template === 'custom' ? q.text! : messageFor(q.template, ctx);
      if (!text) {
        throw Errors.conflict(
          q.template === 'payment_due'
            ? 'Nothing is due for this member'
            : 'This member has no membership yet',
        );
      }
      res.set('Cache-Control', 'no-store');
      ok(res, { template: q.template, phone, text, url: waLink(phone, text) });
    },
  );
  return router;
}
