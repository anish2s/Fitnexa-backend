import type { Request, Response } from 'express';
import { Errors } from '../../lib/errors.js';
import { formatZodIssues } from '../../middleware/error-handler.js';
import { created, ok } from '../../lib/response.js';
import { auditContextFrom } from '../audit/audit.service.js';
import {
  idempotencyKey,
  type OfflinePaymentInput,
  type PaymentListQuery,
} from './payment.schemas.js';
import type { PaymentService } from './payment.service.js';

/** Reads and validates the Idempotency-Key header (required wherever money is recorded). */
export function idempotencyKeyOf(req: Request): string {
  const parsed = idempotencyKey.safeParse(req.get('Idempotency-Key'));
  if (!parsed.success) {
    throw Errors.validation(
      formatZodIssues(parsed.error).map((i) => ({ ...i, path: 'header:Idempotency-Key' })),
    );
  }
  return parsed.data;
}

export function createPaymentController(payments: PaymentService) {
  const idOf = (req: Request) => (req.valid.params as { id: string }).id;
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store');
  return {
    async record(req: Request, res: Response) {
      const key = idempotencyKeyOf(req);
      const { payment, replayed } = await payments.record(
        idOf(req),
        req.valid.body as OfflinePaymentInput,
        key,
        auditContextFrom(req),
      );
      if (replayed) res.set('Idempotent-Replayed', 'true');
      return replayed ? ok(res, payment) : created(res, payment);
    },
    async list(req: Request, res: Response) {
      const { items, meta } = await payments.list(req.valid.query as PaymentListQuery);
      noStore(res);
      ok(res, items, 200, { ...meta });
    },
    async get(req: Request, res: Response) {
      noStore(res);
      ok(res, await payments.get(idOf(req)));
    },
    async forMember(req: Request, res: Response) {
      noStore(res);
      ok(res, await payments.forMember(idOf(req)));
    },
    async selfPayments(req: Request, res: Response) {
      noStore(res);
      ok(res, await payments.selfPayments(req.auth!.userId));
    },
  };
}
