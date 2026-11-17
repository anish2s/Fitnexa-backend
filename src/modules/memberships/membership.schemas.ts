import { z } from 'zod';
import { parseDateOnly } from '../../lib/dates.js';
import { objectId, pageQuery } from '../../lib/pagination.js';
import { offlinePayment } from '../payments/payment.schemas.js';

const DAY = 86_400_000;
/** Back-dating up to a year covers entering existing members; far-future dates are typos. */
const startDate = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const d = parseDateOnly(v);
    if (!d) {
      ctx.addIssue({ code: 'custom', message: 'Use a date like 2026-04-01' });
      return z.NEVER;
    }
    return d;
  })
  .refine(
    (d) => d.getTime() >= Date.now() - 366 * DAY && d.getTime() <= Date.now() + 90 * DAY,
    'Start date must be within the last year or the next 90 days',
  );

const discountPaise = z.number().int().min(0);
const notes = z.string().trim().max(500);

export const membershipIdParams = z.object({ id: objectId });

export const sellBody = z.object({
  planId: objectId,
  /** Defaults to today in the gym's time zone. */
  startDate: startDate.optional(),
  discountPaise: discountPaise.optional(),
  notes: notes.optional(),
  /** Collect the first payment in the same step; needs an Idempotency-Key header. */
  payment: offlinePayment.optional(),
});

export const renewBody = z.object({
  /** Defaults to the plan of the latest membership. */
  planId: objectId.optional(),
  /**
   * expiry: the day after the latest membership ends (even if that's in the past, so a lapse
   * isn't free). today: starts today; refused while a membership is still running.
   * Default: expiry while the latest membership is current or upcoming, otherwise today.
   */
  startFrom: z.enum(['expiry', 'today']).optional(),
  discountPaise: discountPaise.optional(),
  notes: notes.optional(),
  payment: offlinePayment.optional(),
});

export const cancelBody = z.object({ reason: z.string().trim().min(3).max(500) });

export const STATUSES = ['active', 'upcoming', 'expired', 'cancelled'] as const;

export const membershipListQuery = pageQuery.extend({
  status: z.enum(STATUSES).optional(),
  planId: objectId.optional(),
  /** true: only memberships with money still owed (not cancelled). */
  due: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const expiringQuery = pageQuery.extend({
  /** Defaults to the gym's renewalReminderDays setting. */
  days: z.coerce.number().int().min(0).max(90).optional(),
});

export type SellInput = z.infer<typeof sellBody>;
export type RenewInput = z.infer<typeof renewBody>;
export type MembershipListQuery = z.infer<typeof membershipListQuery>;
export type ExpiringQuery = z.infer<typeof expiringQuery>;
