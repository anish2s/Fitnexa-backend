import mongoose, { Types } from 'mongoose';
import type { Env } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { openSecret, sealSecret } from '../../lib/secret-box.js';
import { requireTenantId } from '../../tenancy/context.js';
import type { AuditContext, AuditService } from '../audit/audit.service.js';
import { Member } from '../members/member.model.js';
import { Membership } from '../memberships/membership.model.js';
import type { LeanMembership } from '../memberships/membership.service.js';
import { Tenant } from '../tenants/tenant.model.js';
import { User } from '../users/user.model.js';
import {
  gymPaymentSettings,
  insertPayment,
  insertRefund,
  isDuplicateKey,
  revertRefund,
} from './payment.ledger.js';
import { Payment } from './payment.model.js';
import {
  GatewayAlert,
  PaymentOrder,
  WebhookEvent,
  type LeanGatewayAlert,
  type LeanPaymentOrder,
} from './payment-order.model.js';
import type { LeanPayment } from './payment.view.js';
import {
  RazorpayError,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  type RazorpayClient,
  type RazorpayCreds,
} from './razorpay.client.js';
import type {
  GatewayAlertListQuery,
  GatewayKeysInput,
  RefundInput,
  ResolveGatewayAlertInput,
  VerifyInput,
} from './payment.schemas.js';

function toAlertView(a: LeanGatewayAlert, memberName: string | null) {
  return {
    id: String(a._id),
    kind: 'duplicate_payment' as const,
    status: a.status,
    amountPaise: a.amountPaise,
    razorpayOrderId: a.razorpayOrderId,
    razorpayPaymentId: a.razorpayPaymentId,
    appliedRazorpayPaymentId: a.appliedRazorpayPaymentId ?? null,
    membershipId: String(a.membershipId),
    memberId: String(a.memberId),
    memberName,
    source: a.source,
    createdAt: a.createdAt,
    resolvedAt: a.resolvedAt ?? null,
    resolutionNote: a.resolutionNote ?? null,
  };
}

const SYSTEM: AuditContext = { actor: { type: 'system', name: 'Razorpay webhook' } };

/**
 * Online payments through each gym's own Razorpay account.
 *
 * Money is only ever recorded after proof from Razorpay: a checkout signature (HMAC with the gym's
 * key secret) or a webhook signed with the gym's webhook secret. Both paths converge on capture(),
 * which records a gateway payment id exactly once (unique index), whichever arrives first.
 */
export function createGatewayService(deps: {
  env: Env;
  audit: AuditService;
  logger: Logger;
  razorpay: RazorpayClient;
}) {
  const { env, audit, logger, razorpay } = deps;
  const masterKey = env.PAYMENTS_ENCRYPTION_KEY
    ? Buffer.from(env.PAYMENTS_ENCRYPTION_KEY, 'base64')
    : null;
  const aad = (tenantId: string, what: string) => `${tenantId}:razorpay:${what}`;

  function requireMasterKey(): Buffer {
    if (!masterKey) throw Errors.gatewayNotConfigured();
    return masterKey;
  }

  /** Decrypted credentials of the current gym, or null when Razorpay isn't connected. */
  async function credsOf(): Promise<
    (RazorpayCreds & { webhookSecret: string; gymName: string }) | null
  > {
    const tid = requireTenantId().toHexString();
    const t = await Tenant.findById(tid)
      .select('name razorpay.keyId +razorpay.keySecretEnc +razorpay.webhookSecretEnc')
      .lean();
    const r = t?.razorpay;
    if (!r?.keyId || !r.keySecretEnc || !r.webhookSecretEnc) return null;
    const key = requireMasterKey();
    try {
      return {
        keyId: r.keyId,
        keySecret: openSecret(r.keySecretEnc, key, aad(tid, 'keySecret')),
        webhookSecret: openSecret(r.webhookSecretEnc, key, aad(tid, 'webhookSecret')),
        gymName: t!.name,
      };
    } catch (err) {
      // Wrong/rotated master key or tampered value: treat as not connected; owner re-enters keys.
      logger.error(
        { err: (err as Error).message },
        'Stored Razorpay secrets could not be decrypted',
      );
      return null;
    }
  }

  async function connectedCreds() {
    requireMasterKey();
    const c = await credsOf();
    if (!c) throw Errors.gatewayNotConnected();
    return c;
  }

  // ---------------------------------------------------------------- owner settings

  function webhookUrl(slug: string) {
    return env.GYM_APP_URL_TEMPLATE.replace('{slug}', slug) + '/api/v1/webhooks/razorpay';
  }

  async function getSettings() {
    const t = await Tenant.findById(requireTenantId())
      .select('slug razorpay.keyId razorpay.updatedAt')
      .lean();
    const keyId = t?.razorpay?.keyId ?? null;
    return {
      available: Boolean(masterKey),
      razorpay: {
        connected: Boolean(keyId),
        keyId,
        mode: keyId ? (keyId.startsWith('rzp_live_') ? 'live' : 'test') : null,
        liveAllowed: env.RAZORPAY_ALLOW_LIVE,
        /** Enter this in the Razorpay dashboard → Webhooks, with events payment.captured, order.paid, refund.processed, refund.failed. */
        webhookUrl: t ? webhookUrl(t.slug) : null,
        updatedAt: t?.razorpay?.updatedAt ?? null,
      },
    };
  }

  async function setKeys(input: GatewayKeysInput, ctx: AuditContext) {
    const key = requireMasterKey();
    if (input.keyId.startsWith('rzp_live_') && !env.RAZORPAY_ALLOW_LIVE) {
      throw Errors.validation([
        {
          path: 'keyId',
          message: 'Live keys are not enabled on this server yet; use rzp_test_ keys',
        },
      ]);
    }
    const tid = requireTenantId().toHexString();
    const before = await Tenant.findById(tid).select('razorpay.keyId').lean();
    await Tenant.updateOne(
      { _id: tid },
      {
        $set: {
          'razorpay.keyId': input.keyId,
          'razorpay.keySecretEnc': sealSecret(input.keySecret, key, aad(tid, 'keySecret')),
          'razorpay.webhookSecretEnc': sealSecret(
            input.webhookSecret,
            key,
            aad(tid, 'webhookSecret'),
          ),
          'razorpay.updatedAt': new Date(),
        },
      },
    );
    await audit.record(ctx, {
      action: 'gym.payment_gateway_update',
      target: { type: 'tenant', id: tid },
      // Key id is not secret; the secrets never reach the log.
      metadata: { keyId: input.keyId, previousKeyId: before?.razorpay?.keyId ?? null },
    });
    return getSettings();
  }

  async function removeKeys(ctx: AuditContext) {
    const tid = requireTenantId().toHexString();
    await Tenant.updateOne({ _id: tid }, { $unset: { razorpay: 1 } });
    await audit.record(ctx, {
      action: 'gym.payment_gateway_remove',
      target: { type: 'tenant', id: tid },
    });
    return getSettings();
  }

  // ---------------------------------------------------------------- checkout

  async function createOrder(
    membershipId: string,
    opts: { amountPaise?: number; via: 'desk' | 'member'; memberUserId?: string },
    ctx: AuditContext,
  ) {
    const creds = await connectedCreds();
    const filter: Record<string, unknown> = { _id: membershipId };
    if (opts.via === 'member') {
      const u = await User.findOne({ _id: opts.memberUserId, role: 'member' })
        .select('memberId')
        .lean();
      if (!u?.memberId) throw Errors.notFound('Membership');
      filter.memberId = u.memberId;
    }
    const m = await Membership.findOne(filter).lean<LeanMembership>();
    if (!m) throw Errors.notFound('Membership');
    if (m.cancelledAt) throw Errors.conflict('Membership is cancelled');
    const balance = m.totalPaise - (m.paidPaise ?? 0);
    if (balance < 100) throw Errors.conflict('Nothing to pay on this membership');
    const amount = opts.amountPaise ?? balance;
    if (amount > balance) {
      throw Errors.validation([
        { path: 'amountPaise', message: `Amount is more than the balance due (${balance} paise)` },
      ]);
    }
    const member = await Member.findById(m.memberId).select('name email phone').lean();

    let order;
    try {
      order = await razorpay.createOrder(creds, {
        amountPaise: amount,
        receipt: `ms_${membershipId}`,
        notes: {
          tenantId: requireTenantId().toHexString(),
          membershipId,
          memberId: String(m.memberId),
        },
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Razorpay order creation failed');
      throw Errors.gatewayError('Razorpay could not create the order. Try again.');
    }
    await PaymentOrder.create({
      membershipId: m._id,
      memberId: m.memberId,
      amountPaise: amount,
      razorpayOrderId: order.id,
      createdBy: ctx.actor.id ? new Types.ObjectId(ctx.actor.id) : undefined,
      createdVia: opts.via,
    });
    // Everything Razorpay Checkout needs in the browser. Never the secret.
    return {
      keyId: creds.keyId,
      orderId: order.id,
      amountPaise: amount,
      currency: 'INR',
      name: creds.gymName,
      description: `${m.plan.name} membership`,
      prefill: {
        name: member?.name ?? null,
        email: member?.email ?? null,
        contact: member?.phone ?? null,
      },
    };
  }

  type CaptureResult =
    | { kind: 'payment'; payment: LeanPayment; created: boolean }
    | { kind: 'duplicate'; alert: LeanGatewayAlert; created: boolean };

  /**
   * Records a gateway payment once. Returns the Payment, existing or new.
   *
   * An order pays for its membership exactly once. Claiming the order (created → paid) happens in
   * the same transaction as the payment insert, so of two DIFFERENT payments for one order only one
   * can win, even concurrently; the loser becomes a `duplicate_refund_due` alert instead of
   * paying the membership twice. The SAME payment arriving twice (checkout + webhook) is not a
   * duplicate: it returns the payment already recorded.
   */
  async function capture(
    order: LeanPaymentOrder,
    paymentId: string,
    amountPaise: number,
    ctx: AuditContext,
    source: 'checkout' | 'webhook',
  ): Promise<CaptureResult> {
    const existing = await Payment.findOne({ 'gateway.paymentId': paymentId }).lean<LeanPayment>();
    if (existing) return { kind: 'payment', payment: existing, created: false };
    const known = await GatewayAlert.findOne({
      razorpayPaymentId: paymentId,
    }).lean<LeanGatewayAlert>();
    if (known) return { kind: 'duplicate', alert: known, created: false };

    const settings = await gymPaymentSettings();
    const session = await mongoose.startSession();
    let id: Types.ObjectId | null = null;
    try {
      await session.withTransaction(async () => {
        id = null; // the callback may be retried after a write conflict
        const claim = await PaymentOrder.updateOne(
          { _id: order._id, status: 'created' },
          { $set: { status: 'paid', razorpayPaymentId: paymentId } },
          { session },
        );
        if (claim.matchedCount === 0) return; // already paid: commit nothing
        id = await insertPayment(
          session,
          {
            membershipId: order.membershipId,
            memberId: order.memberId,
            amountPaise,
            method: 'razorpay',
            reference: paymentId,
            receivedAt: new Date(),
            receivedBy: ctx.actor.type === 'user' ? ctx.actor.id : undefined,
            gateway: { provider: 'razorpay', orderId: order.razorpayOrderId, paymentId },
            enforceBalance: false,
          },
          settings,
        );
      });
    } catch (err) {
      if (isDuplicateKey(err, 'gateway.paymentId')) {
        const p = await Payment.findOne({ 'gateway.paymentId': paymentId }).lean<LeanPayment>();
        return { kind: 'payment', payment: p!, created: false };
      }
      throw err;
    } finally {
      await session.endSession();
    }

    if (!id) {
      const paid = await PaymentOrder.findById(order._id).lean<LeanPaymentOrder>();
      if (paid?.razorpayPaymentId === paymentId) {
        // The same payment won the race through the other path (checkout vs webhook).
        const p = await Payment.findOne({ 'gateway.paymentId': paymentId }).lean<LeanPayment>();
        return { kind: 'payment', payment: p!, created: false };
      }
      return recordDuplicate(order, paid?.razorpayPaymentId ?? null, paymentId, amountPaise, {
        ctx,
        source,
      });
    }

    const p = await Payment.findById(id).lean<LeanPayment>();
    await audit.record(ctx, {
      action: 'payment.record',
      target: { type: 'payment', id: String(id) },
      metadata: {
        receiptNumber: p!.receiptNumber,
        amountPaise,
        method: 'razorpay',
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: paymentId,
        membershipId: String(order.membershipId),
      },
    });
    return { kind: 'payment', payment: p!, created: true };
  }

  /** Not applied to the membership, not refunded: recorded for the owner, once per payment. */
  async function recordDuplicate(
    order: LeanPaymentOrder,
    appliedPaymentId: string | null,
    paymentId: string,
    amountPaise: number,
    opts: { ctx: AuditContext; source: 'checkout' | 'webhook' },
  ): Promise<CaptureResult> {
    let alert: LeanGatewayAlert;
    try {
      const doc = await GatewayAlert.create({
        status: 'duplicate_refund_due',
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: paymentId,
        appliedRazorpayPaymentId: appliedPaymentId,
        amountPaise,
        membershipId: order.membershipId,
        memberId: order.memberId,
        source: opts.source,
      });
      alert = doc.toObject() as unknown as LeanGatewayAlert;
    } catch (err) {
      if (!isDuplicateKey(err, 'razorpayPaymentId')) throw err;
      const a = await GatewayAlert.findOne({
        razorpayPaymentId: paymentId,
      }).lean<LeanGatewayAlert>();
      return { kind: 'duplicate', alert: a!, created: false };
    }
    logger.warn(
      { orderId: order.razorpayOrderId, paymentId, source: opts.source },
      'Second payment on an already-paid Razorpay order; refund due',
    );
    await audit.record(opts.ctx, {
      action: 'payment.duplicate_gateway_payment',
      target: { type: 'membership', id: String(order.membershipId) },
      metadata: {
        alertId: String(alert._id),
        amountPaise,
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: paymentId,
        appliedRazorpayPaymentId: appliedPaymentId,
        source: opts.source,
      },
    });
    return { kind: 'duplicate', alert, created: true };
  }

  // ---------------------------------------------------------------- owner alerts

  async function listAlerts(q: GatewayAlertListQuery) {
    const filter = q.status === 'all' ? {} : { status: q.status };
    const [items, openCount] = await Promise.all([
      GatewayAlert.find(filter).sort({ createdAt: -1 }).limit(200).lean<LeanGatewayAlert[]>(),
      GatewayAlert.countDocuments({ status: 'duplicate_refund_due' }),
    ]);
    const names = new Map(
      (
        await Member.find({ _id: { $in: items.map((a) => a.memberId) } })
          .select('name')
          .lean()
      ).map((m) => [String(m._id), m.name]),
    );
    return {
      openCount,
      items: items.map((a) => toAlertView(a, names.get(String(a.memberId)) ?? null)),
    };
  }

  async function resolveAlert(id: string, input: ResolveGatewayAlertInput, ctx: AuditContext) {
    const a = await GatewayAlert.findOneAndUpdate(
      { _id: id, status: 'duplicate_refund_due' },
      {
        $set: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolvedBy: ctx.actor.id ? new Types.ObjectId(ctx.actor.id) : undefined,
          resolutionNote: input.note,
        },
      },
      { returnDocument: 'after' },
    ).lean<LeanGatewayAlert>();
    if (!a) {
      if (await GatewayAlert.exists({ _id: id }))
        throw Errors.conflict('Alert is already resolved');
      throw Errors.notFound('Alert');
    }
    await audit.record(ctx, {
      action: 'payment.duplicate_gateway_payment_resolve',
      target: { type: 'membership', id: String(a.membershipId) },
      metadata: {
        alertId: id,
        amountPaise: a.amountPaise,
        razorpayPaymentId: a.razorpayPaymentId,
        note: input.note,
      },
    });
    return toAlertView(a, null);
  }

  /** Browser callback after Checkout. Members may only complete their own orders. */
  async function verify(input: VerifyInput, ctx: AuditContext, memberUserId?: string) {
    const creds = await connectedCreds();
    const order = await PaymentOrder.findOne({
      razorpayOrderId: input.orderId,
    }).lean<LeanPaymentOrder>();
    if (!order) throw Errors.notFound('Order');
    if (memberUserId) {
      const u = await User.findOne({ _id: memberUserId, role: 'member' }).select('memberId').lean();
      if (!u?.memberId || String(u.memberId) !== String(order.memberId))
        throw Errors.notFound('Order');
    }
    if (
      !verifyCheckoutSignature(input.orderId, input.paymentId, input.signature, creds.keySecret)
    ) {
      logger.warn({ orderId: input.orderId }, 'Razorpay checkout signature mismatch');
      throw Errors.invalidSignature();
    }
    // The order fixes the amount; a valid signature proves this payment is for this order.
    const r = await capture(order, input.paymentId, order.amountPaise, ctx, 'checkout');
    if (r.kind === 'duplicate') throw Errors.duplicateGatewayPayment(String(r.alert._id));
    return r;
  }

  // ---------------------------------------------------------------- webhooks

  type WebhookBody = {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; amount?: number; status?: string } };
      refund?: { entity?: { id?: string; payment_id?: string; amount?: number; status?: string } };
    };
  };

  async function webhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    eventId: string | undefined,
  ) {
    if (!masterKey) throw Errors.notFound('Webhook');
    const creds = await credsOf();
    if (!creds) throw Errors.notFound('Webhook');
    if (
      !rawBody ||
      !signature ||
      !verifyWebhookSignature(rawBody, signature, creds.webhookSecret)
    ) {
      logger.warn({ eventId }, 'Razorpay webhook signature mismatch');
      throw Errors.invalidSignature();
    }
    if (eventId && (await WebhookEvent.exists({ provider: 'razorpay', eventId }))) {
      return { status: 'duplicate' };
    }
    const body = JSON.parse(rawBody.toString('utf8')) as WebhookBody;
    let status = 'ignored';

    if (body.event === 'payment.captured' || body.event === 'order.paid') {
      const pay = body.payload?.payment?.entity;
      if (pay?.id && pay.order_id && typeof pay.amount === 'number') {
        const order = await PaymentOrder.findOne({
          razorpayOrderId: pay.order_id,
        }).lean<LeanPaymentOrder>();
        if (order) {
          const r = await capture(order, pay.id, pay.amount, SYSTEM, 'webhook');
          status = r.kind === 'duplicate' ? 'duplicate_refund_due' : 'captured';
        } else {
          logger.warn({ orderId: pay.order_id }, 'Webhook for an order this gym did not create');
        }
      }
    } else if (body.event === 'refund.processed' || body.event === 'refund.failed') {
      const ref = body.payload?.refund?.entity;
      if (ref?.id) status = await settleRefund(ref.id, body.event === 'refund.processed');
    }

    if (eventId) {
      await WebhookEvent.create({ provider: 'razorpay', eventId, event: body.event }).catch(
        (err: unknown) => {
          if (!isDuplicateKey(err, 'eventId')) throw err;
        },
      );
    }
    return { status };
  }

  /** refund.processed → mark processed; refund.failed → revert the amounts. */
  async function settleRefund(gatewayRefundId: string, processed: boolean) {
    const p = await Payment.findOne({
      'refunds.gatewayRefundId': gatewayRefundId,
    }).lean<LeanPayment>();
    const r = p?.refunds?.find((x) => x.gatewayRefundId === gatewayRefundId);
    if (!p || !r) return 'unknown_refund';
    if (processed) {
      await Payment.updateOne(
        { _id: p._id, 'refunds._id': r._id, 'refunds.status': 'pending' },
        { $set: { 'refunds.$.status': 'processed' } },
      );
      return 'refund_processed';
    }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => revertRefund(session, p._id, r._id));
    } finally {
      await session.endSession();
    }
    await audit.record(SYSTEM, {
      action: 'payment.refund_failed',
      target: { type: 'payment', id: String(p._id) },
      metadata: { refundNumber: r.refundNumber, amountPaise: r.amountPaise, gatewayRefundId },
    });
    return 'refund_failed';
  }

  // ---------------------------------------------------------------- gateway refunds

  /**
   * Reserve, then call, then settle: the refund is written as `pending` (amounts moved) BEFORE
   * asking Razorpay, so money can never go back without a record. If Razorpay refuses, the
   * reservation is reverted and the caller gets 502.
   */
  async function refundOnline(p: LeanPayment, input: RefundInput, key: string, ctx: AuditContext) {
    const creds = await connectedCreds();
    if (!p.gateway?.paymentId) throw Errors.conflict('This payment has no gateway reference');
    const settings = await gymPaymentSettings();
    const session = await mongoose.startSession();
    let refundId: Types.ObjectId | null = null;
    try {
      await session.withTransaction(async () => {
        refundId = await insertRefund(
          session,
          {
            paymentId: p._id,
            membershipId: p.membershipId,
            amountPaise: input.amountPaise,
            method: 'gateway',
            reason: input.reason,
            status: 'pending',
            idempotencyKey: key,
            refundedBy: ctx.actor.id,
          },
          settings,
        );
        if (!refundId) {
          throw Errors.validation([
            { path: 'amountPaise', message: 'Refund is more than what is left on this payment' },
          ]);
        }
      });
    } finally {
      await session.endSession();
    }

    try {
      const r = await razorpay.refund(creds, {
        paymentId: p.gateway.paymentId,
        amountPaise: input.amountPaise,
        notes: { refundId: String(refundId) },
      });
      await Payment.updateOne(
        { _id: p._id, 'refunds._id': refundId },
        {
          $set: {
            'refunds.$.gatewayRefundId': r.id,
            'refunds.$.status': r.status === 'processed' ? 'processed' : 'pending',
          },
        },
      );
    } catch (err) {
      const s2 = await mongoose.startSession();
      try {
        await s2.withTransaction(() => revertRefund(s2, p._id, refundId!));
      } finally {
        await s2.endSession();
      }
      logger.warn(
        { err: (err as Error).message, paymentId: String(p._id) },
        'Razorpay refund failed',
      );
      throw Errors.gatewayError(
        err instanceof RazorpayError
          ? `Razorpay refused the refund: ${err.message}`
          : 'Could not reach Razorpay',
      );
    }
    return refundId!;
  }

  return {
    getSettings,
    setKeys,
    removeKeys,
    createOrder,
    verify,
    webhook,
    refundOnline,
    listAlerts,
    resolveAlert,
  };
}

export type GatewayService = ReturnType<typeof createGatewayService>;
