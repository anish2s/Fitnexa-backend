import { z } from 'zod';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-04-01');

/** All reports: gym-local dates, inclusive. Defaults: the last 30 days, grouping by range length. */
export const rangeQuery = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  groupBy: z.enum(['day', 'week', 'month']).optional(),
});
export type RangeQuery = z.infer<typeof rangeQuery>;
