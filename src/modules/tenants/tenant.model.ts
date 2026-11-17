import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * A gym. This is the ONE collection that is not tenant-scoped: it *is* the tenant registry.
 * Only the resolver (by host) and super-admin code read it across tenants.
 */

export const TENANT_STATUSES = ['active', 'suspended', 'archived'] as const;
export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled'] as const;

/** Lowercase letters, digits and inner hyphens; 3–40 chars. Valid as a DNS label. */
export const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const brandingSchema = new Schema(
  {
    logoUrl: { type: String, trim: true, maxlength: 500 },
    appIconUrl: { type: String, trim: true, maxlength: 500 },
    primaryColor: { type: String, match: HEX_COLOR, default: '#7C3AED' },
    secondaryColor: { type: String, match: HEX_COLOR, default: '#0F172A' },
    /** Default theme for this gym's users; each user can still override it. */
    defaultTheme: { type: String, enum: ['dark', 'light', 'system'], default: 'dark' },
  },
  { _id: false },
);

const addressSchema = new Schema(
  {
    line1: { type: String, trim: true, maxlength: 200 },
    line2: { type: String, trim: true, maxlength: 200 },
    city: { type: String, trim: true, maxlength: 100 },
    state: { type: String, trim: true, maxlength: 100 },
    postalCode: { type: String, trim: true, maxlength: 20 },
    country: { type: String, trim: true, uppercase: true, length: 2, default: 'IN' },
  },
  { _id: false },
);

const settingsSchema = new Schema(
  {
    timezone: { type: String, default: 'Asia/Kolkata' },
    currency: { type: String, uppercase: true, length: 3, default: 'INR' },
    locale: { type: String, default: 'en-IN' },
    /** GSTIN printed on receipts; optional because many small gyms are unregistered. */
    gstin: { type: String, trim: true, uppercase: true, maxlength: 15 },
    receiptPrefix: { type: String, trim: true, uppercase: true, maxlength: 10, default: 'RCPT' },
    /** Days before expiry when renewal reminders start. */
    renewalReminderDays: { type: Number, min: 0, max: 60, default: 7 },
  },
  { _id: false },
);

const tenantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    /** Stable identifier. Also the subdomain: powerhouse → powerhouse.yourapp.in */
    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: SUBDOMAIN_PATTERN,
      unique: true,
    },
    /** Future: app.powerhousegym.in. Only used for resolution once verified. */
    customDomain: { type: String, lowercase: true, trim: true, maxlength: 253 },
    customDomainVerified: { type: Boolean, default: false },

    branding: { type: brandingSchema, default: () => ({}) },
    address: { type: addressSchema, default: () => ({}) },
    settings: { type: settingsSchema, default: () => ({}) },

    phone: { type: String, trim: true, maxlength: 20 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },

    status: { type: String, enum: TENANT_STATUSES, default: 'active', index: true },
    subscription: {
      status: { type: String, enum: SUBSCRIPTION_STATUSES, default: 'trialing' },
      planCode: { type: String, trim: true },
      /** Monthly platform fee in paise (₹999 → 99900). Integers only for money. */
      priceMonthlyPaise: { type: Number, min: 0 },
      currentPeriodEnd: { type: Date },
    },
    suspendedAt: { type: Date },
    suspendedReason: { type: String, maxlength: 500 },
    /**
     * The gym's own Razorpay account (money lands with the gym, not the platform). Secrets are
     * AES-256-GCM ciphertext (lib/secret-box.ts) and never selected unless asked for.
     */
    razorpay: {
      keyId: { type: String, maxlength: 64 },
      keySecretEnc: { type: String, select: false, maxlength: 512 },
      webhookSecretEnc: { type: String, select: false, maxlength: 512 },
      updatedAt: { type: Date },
    },
  },
  { timestamps: true },
);

// Custom domains must be unique among the tenants that set one.
tenantSchema.index(
  { customDomain: 1 },
  { unique: true, partialFilterExpression: { customDomain: { $type: 'string' } } },
);

export type TenantAttrs = InferSchemaType<typeof tenantSchema>;
export type TenantDoc = HydratedDocument<TenantAttrs>;

export const Tenant = model('Tenant', tenantSchema);

/** The only tenant fields that may be shown to unauthenticated visitors (login page branding). */
export function toPublicBranding(t: TenantAttrs & { _id?: unknown }) {
  return {
    name: t.name,
    slug: t.slug,
    logoUrl: t.branding?.logoUrl ?? null,
    appIconUrl: t.branding?.appIconUrl ?? null,
    primaryColor: t.branding?.primaryColor ?? '#7C3AED',
    secondaryColor: t.branding?.secondaryColor ?? '#0F172A',
    defaultTheme: t.branding?.defaultTheme ?? 'dark',
    status: t.status,
  };
}
