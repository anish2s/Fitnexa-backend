import { Router } from 'express';
import type { JwtConfig } from '../../auth/jwt.js';
import { Errors } from '../../lib/errors.js';
import { created, ok } from '../../lib/response.js';
import {
  authenticate,
  authorize,
  authorizeAny,
  notWhileImpersonating,
} from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { documentsHeader } from '../../lib/route-meta.js';
import { auditContextFrom } from '../audit/audit.service.js';
import { membershipIdParams } from '../memberships/membership.schemas.js';
import type { GatewayService } from './gateway.service.js';
import { toPaymentView } from './payment.view.js';
import * as s from './payment.schemas.js';

/**
 * Razorpay endpoints, mounted at:
 *  /gym/payment-gateway                 owner connects/disconnects the gym's Razorpay account
 *  /gym/payment-gateway/alerts          duplicate online payments the owner must refund
 *  /memberships/:id/razorpay-order      desk creates a checkout order for a balance
 *  /members/me/memberships/:id/razorpay-order   member pays their own membership
 *  /payments/razorpay/verify            checkout callback (desk or member)
 *  /webhooks/razorpay                   Razorpay → us, signed with the gym's webhook secret
 */
export function gatewayRouters(deps: { jwt: JwtConfig; gateway: GatewayService }) {
  const g = deps.gateway;
  const auth = authenticate(deps.jwt);

  const settings = Router();
  // Payout keys decide where the gym's money goes: owner only, and never while a super admin is
  // signed in as the owner.
  settings.get('/', auth, authorize('gym:update'), async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    ok(res, await g.getSettings());
  });
  settings.put(
    '/razorpay',
    auth,
    authorize('gym:update'),
    notWhileImpersonating,
    validate({ body: s.gatewayKeysBody }),
    async (req, res) => {
      ok(res, await g.setKeys(req.valid.body as s.GatewayKeysInput, auditContextFrom(req)));
    },
  );
  settings.delete(
    '/razorpay',
    auth,
    authorize('gym:update'),
    notWhileImpersonating,
    async (req, res) => {
      ok(res, await g.removeKeys(auditContextFrom(req)));
    },
  );

  // Second payments on already-paid orders, kept out of the books until the owner refunds them in
  // Razorpay. Refund permission, because acting on one means sending money back.
  settings.get(
    '/alerts',
    auth,
    authorize('payments:refund'),
    validate({ query: s.gatewayAlertListQuery }),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      ok(res, await g.listAlerts(req.valid.query as s.GatewayAlertListQuery));
    },
  );
  settings.post(
    '/alerts/:id/resolve',
    auth,
    authorize('payments:refund'),
    validate({ params: s.gatewayAlertIdParams, body: s.resolveGatewayAlertBody }),
    async (req, res) => {
      const { id } = req.valid.params as { id: string };
      ok(
        res,
        await g.resolveAlert(
          id,
          req.valid.body as s.ResolveGatewayAlertInput,
          auditContextFrom(req),
        ),
      );
    },
  );

  const deskOrders = Router();
  deskOrders.post(
    '/:id/razorpay-order',
    auth,
    authorize('payments:record'),
    validate({ params: membershipIdParams, body: s.orderBody }),
    async (req, res) => {
      const { id } = req.valid.params as { id: string };
      const { amountPaise } = req.valid.body as { amountPaise?: number };
      created(res, await g.createOrder(id, { amountPaise, via: 'desk' }, auditContextFrom(req)));
    },
  );

  const memberOrders = Router();
  memberOrders.post(
    '/me/memberships/:id/razorpay-order',
    auth,
    authorize('self:pay'),
    validate({ params: membershipIdParams, body: s.orderBody }),
    async (req, res) => {
      const { id } = req.valid.params as { id: string };
      const { amountPaise } = req.valid.body as { amountPaise?: number };
      created(
        res,
        await g.createOrder(
          id,
          { amountPaise, via: 'member', memberUserId: req.auth!.userId },
          auditContextFrom(req),
        ),
      );
    },
  );

  const verify = Router();
  verify.post(
    '/razorpay/verify',
    auth,
    authorizeAny('payments:record', 'self:pay'),
    validate({ body: s.verifyBody }),
    async (req, res) => {
      const a = req.auth!;
      // Desk staff may complete any order of this gym; a member only their own.
      const asMember = a.kind === 'tenant' && !a.permissions.has('payments:record');
      const { payment, created: isNew } = await g.verify(
        req.valid.body as s.VerifyInput,
        auditContextFrom(req),
        asMember ? a.userId : undefined,
      );
      const view = toPaymentView(payment, { forMember: asMember });
      return isNew ? created(res, view) : ok(res, view);
    },
  );

  const webhooks = Router();
  webhooks.post(
    '/razorpay',
    documentsHeader(
      'X-Razorpay-Signature',
      true,
      "HMAC-SHA256 of the raw body with the gym's webhook secret.",
    ),
    documentsHeader('X-Razorpay-Event-Id', false, 'Used to ignore repeated deliveries.'),
    async (req, res) => {
      if (!req.tenant) throw Errors.notFound('Webhook');
      const result = await g.webhook(
        req.rawBody,
        req.get('X-Razorpay-Signature'),
        req.get('X-Razorpay-Event-Id'),
      );
      ok(res, result);
    },
  );

  return { settings, deskOrders, memberOrders, verify, webhooks };
}
