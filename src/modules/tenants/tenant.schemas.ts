import { z } from 'zod';
import { normalizePhone } from '../../lib/phone.js';

/**
 * Gym profile, settings and branding inputs. Shared by the owner's own endpoints (/gym) and the
 * super admin's (/platform/tenants). `null` clears an optional field.
 */

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #7C3AED');
const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => u.startsWith('https://'), 'Must be an https:// URL');

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const emailField = z.string().trim().toLowerCase().email().max(254);
export const phoneField = z
  .string()
  .trim()
  .max(20)
  .transform((v, ctx) => {
    const p = normalizePhone(v);
    if (!p) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' });
      return z.NEVER;
    }
    return p;
  });

/** 15-character Indian GST number, e.g. 27AAPFU0939F1ZV. */
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN');

export const nonEmpty = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).refine((o) => Object.values(o).some((v) => v !== undefined), 'Nothing to update');

export const brandingShape = {
  logoUrl: httpsUrl.nullable().optional(),
  appIconUrl: httpsUrl.nullable().optional(),
  primaryColor: hexColor.optional(),
  secondaryColor: hexColor.optional(),
  defaultTheme: z.enum(['dark', 'light', 'system']).optional(),
};
export const brandingPatch = nonEmpty(brandingShape);

const optText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

export const addressPatch = z.object({
  line1: optText(200),
  line2: optText(200),
  city: optText(100),
  state: optText(100),
  postalCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9 -]{3,12}$/, 'Enter a valid postal code')
    .nullable()
    .optional(),
});

export const settingsPatch = z.object({
  timezone: z.string().refine(isValidTimeZone, 'Unknown time zone').optional(),
  gstin: gstin.nullable().optional(),
  receiptPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,10}$/, 'Letters and digits only, up to 10')
    .optional(),
  renewalReminderDays: z.number().int().min(0).max(60).optional(),
});

/** What a gym owner may change about their own gym (`gym:update`). */
export const profileShape = {
  name: z.string().trim().min(2).max(120).optional(),
  email: emailField.nullable().optional(),
  phone: phoneField.nullable().optional(),
  address: addressPatch.optional(),
  settings: settingsPatch.optional(),
};
export const profilePatch = nonEmpty(profileShape);

export type BrandingPatch = z.infer<typeof brandingPatch>;
export type ProfilePatch = z.infer<typeof profilePatch>;
