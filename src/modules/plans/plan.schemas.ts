import { z } from 'zod';
import { GST_RATES, TAX_MODES } from '../../lib/money.js';
import { objectId, pageQuery } from '../../lib/pagination.js';

const gstRate = z.union(
  GST_RATES.map((r) => z.literal(r)) as unknown as [
    z.ZodLiteral<0>,
    z.ZodLiteral<5>,
    ...z.ZodLiteral<number>[],
  ],
);

export const planIdParams = z.object({ id: objectId });

export const planListQuery = pageQuery.extend({
  archived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
});

const fields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  durationDays: z.number().int().min(1).max(1095),
  /** Integer paise, e.g. ₹4,500 → 450000. */
  pricePaise: z.number().int().min(0).max(1_00_00_000),
  taxMode: z.enum(TAX_MODES),
  gstRate,
};

export const createPlanBody = z.object({
  name: fields.name,
  description: fields.description.optional(),
  durationDays: fields.durationDays,
  pricePaise: fields.pricePaise,
  /** Default: GST included in the price at 18% when the gym has a GSTIN, otherwise no GST. */
  taxMode: fields.taxMode.optional(),
  gstRate: fields.gstRate.optional(),
});

export const updatePlanBody = z
  .object({
    name: fields.name.optional(),
    description: fields.description.nullable().optional(),
    durationDays: fields.durationDays.optional(),
    pricePaise: fields.pricePaise.optional(),
    taxMode: fields.taxMode.optional(),
    gstRate: fields.gstRate.optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), 'Nothing to update');

export type CreatePlanInput = z.infer<typeof createPlanBody>;
export type UpdatePlanInput = z.infer<typeof updatePlanBody>;
export type PlanListQuery = z.infer<typeof planListQuery>;
