import { z } from 'zod';
import { objectId, pageQuery } from '../../lib/pagination.js';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-04-01');

export const scanBody = z.object({ token: z.string().trim().min(10).max(200) });
export const manualBody = z.object({ memberId: objectId });

export const dayQuery = pageQuery.extend({
  /** Gym-local date; defaults to today. */
  date: dateOnly.optional(),
});
export const reportQuery = z.object({ date: dateOnly.optional() });

export const rangeQuery = pageQuery.extend({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export type DayQuery = z.infer<typeof dayQuery>;
export type RangeQuery = z.infer<typeof rangeQuery>;
