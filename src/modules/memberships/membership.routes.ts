import { Router } from 'express';
import type { JwtConfig } from '../../auth/jwt.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { memberIdParams } from '../members/member.schemas.js';
import type { AuditService } from '../audit/audit.service.js';
import type { Env } from '../../config/env.js';
import { createMembershipController } from './membership.controller.js';
import * as s from './membership.schemas.js';
import { createMembershipService } from './membership.service.js';

/**
 * Two routers sharing one service:
 *  - /api/v1/memberships           gym-wide lists, expiring soon, cancel
 *  - /api/v1/members/:id/memberships  one member's history, sell, renew (+ /members/me/memberships)
 * The member router authenticates per route (no router.use), so it adds no cost to other
 * /members requests it doesn't handle.
 */
export function membershipRouters(deps: { jwt: JwtConfig; audit: AuditService; env?: Env }) {
  const c = createMembershipController(createMembershipService(deps));
  const auth = authenticate(deps.jwt);
  const read = authorize('memberships:read');
  const manage = authorize('memberships:manage');

  const memberships = Router();
  memberships.get('/', auth, read, validate({ query: s.membershipListQuery }), c.list);
  memberships.get('/expiring', auth, read, validate({ query: s.expiringQuery }), c.expiring);
  memberships.post(
    '/:id/cancel',
    auth,
    manage,
    validate({ params: s.membershipIdParams, body: s.cancelBody }),
    c.cancel,
  );

  const perMember = Router();
  perMember.get('/me/memberships', auth, authorize('self:read'), c.selfHistory);
  perMember.get('/:id/memberships', auth, read, validate({ params: memberIdParams }), c.history);
  perMember.post(
    '/:id/memberships',
    auth,
    manage,
    validate({ params: memberIdParams, body: s.sellBody }),
    c.create,
  );
  perMember.post(
    '/:id/memberships/renew',
    auth,
    manage,
    validate({ params: memberIdParams, body: s.renewBody }),
    c.renew,
  );
  return { memberships, perMember };
}
