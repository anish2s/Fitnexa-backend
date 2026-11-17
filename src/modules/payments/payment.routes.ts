import { Router } from 'express';
import type { JwtConfig } from '../../auth/jwt.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { documentsHeader, produces } from '../../lib/route-meta.js';
import type { AuditService } from '../audit/audit.service.js';
import { memberIdParams } from '../members/member.schemas.js';
import { membershipIdParams } from '../memberships/membership.schemas.js';
import { createPaymentController } from './payment.controller.js';
import * as s from './payment.schemas.js';
import { createPaymentService } from './payment.service.js';
import type { GatewayService } from './gateway.service.js';

/**
 * Payments, mounted in three places (same service):
 *  /payments                         gym-wide list, one payment
 *  /memberships/:id/payments         record a desk payment against a membership
 *  /members/:id/payments, /members/me/payments
 * Routers authenticate per route so they add nothing to requests they don't handle.
 */
export function paymentRouters(deps: {
  jwt: JwtConfig;
  audit: AuditService;
  gateway?: GatewayService;
}) {
  const c = createPaymentController(createPaymentService(deps));
  const auth = authenticate(deps.jwt);
  const read = authorize('payments:read');

  const payments = Router();
  payments.get('/', auth, read, validate({ query: s.paymentListQuery }), c.list);
  payments.get('/:id', auth, read, validate({ params: s.paymentIdParams }), c.get);
  payments.post(
    '/:id/refunds',
    auth,
    authorize('payments:refund'),
    documentsHeader(
      'Idempotency-Key',
      true,
      'Unique per intended refund (e.g. a UUID); retries with the same key return the original result.',
    ),
    validate({ params: s.paymentIdParams, body: s.refundBody }),
    c.refund,
  );
  payments.get(
    '/:id/receipt',
    auth,
    read,
    produces('application/pdf'),
    validate({ params: s.paymentIdParams }),
    c.receipt,
  );

  const perMembership = Router();
  perMembership.post(
    '/:id/payments',
    auth,
    authorize('payments:record'),
    documentsHeader(
      'Idempotency-Key',
      true,
      'Unique per intended payment (e.g. a UUID); retries with the same key return the original result.',
    ),
    validate({ params: membershipIdParams, body: s.offlinePayment }),
    c.record,
  );

  const perMember = Router();
  perMember.get('/me/payments', auth, authorize('self:read'), c.selfPayments);
  perMember.get(
    '/me/payments/:id/receipt',
    auth,
    authorize('self:read'),
    produces('application/pdf'),
    validate({ params: s.paymentIdParams }),
    c.selfReceipt,
  );
  perMember.get('/:id/payments', auth, read, validate({ params: memberIdParams }), c.forMember);

  return { payments, perMembership, perMember };
}
