import { z } from 'zod';
import { objectId, pageQuery } from '../../lib/pagination.js';
import { SUBSCRIPTION_STATUSES, TENANT_STATUSES } from '../tenants/tenant.model.js';
import {
  addressPatch,
  brandingShape,
  emailField,
  nonEmpty,
  phoneField,
  profileShape,
  settingsPatch,
} from '../tenants/tenant.schemas.js';

export const tenantIdParams = z.object({ id: objectId });

export const tenantListQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(TENANT_STATUSES).optional(),
});

export const slugQuery = z.object({ slug: z.string().trim().toLowerCase().min(1).max(63) });

const subscriptionShape = {
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  planCode: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{1,40}$/, 'Lowercase letters, digits, _ and - only')
    .nullable()
    .optional(),
  /** Integer paise: ₹999 → 99900. */
  priceMonthlyPaise: z.number().int().min(0).max(1_00_00_000).nullable().optional(),
  currentPeriodEnd: z.coerce.date().nullable().optional(),
};

export const createTenantBody = z.object({
  name: z.string().trim().min(2).max(120),
  /** Becomes the subdomain; checked against format, reserved names and existing gyms. */
  slug: z.string().trim().toLowerCase().min(3).max(40),
  email: emailField.optional(),
  phone: phoneField.optional(),
  address: addressPatch.optional(),
  settings: settingsPatch.optional(),
  branding: z.object(brandingShape).optional(),
  subscription: z.object(subscriptionShape).optional(),
  owner: z.object({
    name: z.string().trim().min(1).max(120),
    /** Required: the owner sets a password from the emailed invite. */
    email: emailField,
    phone: phoneField.optional(),
  }),
});

/** Super admin edit: everything the owner can change, plus the platform subscription. */
export const platformTenantPatch = nonEmpty({
  ...profileShape,
  subscription: z
    .object(subscriptionShape)
    .refine((o) => Object.values(o).some((v) => v !== undefined), 'Nothing to update')
    .optional(),
});

export const platformBrandingPatch = nonEmpty(brandingShape);

export const suspendBody = z.object({
  /** Shown to nobody but the platform; recorded in the gym's audit log. */
  reason: z.string().trim().min(3).max(500),
});

/** A branding image the super admin uploads for a gym (the gym-host route signs only the host's gym). */
export const brandingSignatureBody = z.object({
  purpose: z.enum(['gym_logo', 'gym_icon', 'gym_cover']),
});

export const impersonateBody = z.object({
  /** Why you need the owner's view, e.g. a support ticket number. Required and audited. */
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500),
});

export type CreateTenantInput = z.infer<typeof createTenantBody>;
