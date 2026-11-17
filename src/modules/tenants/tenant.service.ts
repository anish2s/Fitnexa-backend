import type { Types } from 'mongoose';
import { Errors } from '../../lib/errors.js';
import { diffChanges, type AuditChange } from '../audit/audit.service.js';
import { Tenant, type TenantAttrs } from './tenant.model.js';

type LeanTenant = TenantAttrs & {
  _id: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

/** Full gym record for the owner's settings page and the super admin console. */
export function toTenantView(t: LeanTenant) {
  const b = t.branding ?? {};
  const a = t.address ?? {};
  const s = t.settings ?? {};
  const sub: Partial<NonNullable<TenantAttrs['subscription']>> = t.subscription ?? {};
  return {
    id: String(t._id),
    name: t.name,
    slug: t.slug,
    status: t.status,
    email: t.email ?? null,
    phone: t.phone ?? null,
    customDomain: t.customDomain ?? null,
    customDomainVerified: Boolean(t.customDomainVerified),
    address: {
      line1: a.line1 ?? null,
      line2: a.line2 ?? null,
      city: a.city ?? null,
      state: a.state ?? null,
      postalCode: a.postalCode ?? null,
      country: a.country ?? 'IN',
    },
    settings: {
      timezone: s.timezone ?? 'Asia/Kolkata',
      currency: s.currency ?? 'INR',
      locale: s.locale ?? 'en-IN',
      gstin: s.gstin ?? null,
      receiptPrefix: s.receiptPrefix ?? 'RCPT',
      renewalReminderDays: s.renewalReminderDays ?? 7,
      renewalRemindersEnabled: s.renewalRemindersEnabled ?? true,
    },
    branding: {
      logoUrl: b.logoUrl ?? null,
      appIconUrl: b.appIconUrl ?? null,
      primaryColor: b.primaryColor ?? '#7C3AED',
      secondaryColor: b.secondaryColor ?? '#0F172A',
      defaultTheme: b.defaultTheme ?? 'dark',
    },
    subscription: {
      status: sub.status ?? 'trialing',
      planCode: sub.planCode ?? null,
      priceMonthlyPaise: sub.priceMonthlyPaise ?? null,
      currentPeriodEnd: sub.currentPeriodEnd ?? null,
    },
    suspendedAt: t.suspendedAt ?? null,
    suspendedReason: t.suspendedReason ?? null,
    createdAt: t.createdAt ?? null,
    updatedAt: t.updatedAt ?? null,
  };
}
export type TenantView = ReturnType<typeof toTenantView>;

/**
 * Turns a validated patch into dotted `$set` / `$unset` paths, one level deep for sub-documents
 * (`settings.timezone`), so changing one setting never wipes the others. `null` means "clear".
 */
export function flattenPatch(patch: Record<string, unknown>, prefix = '') {
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null) unset[path] = 1;
    else if (typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
      const inner = flattenPatch(value as Record<string, unknown>, path);
      Object.assign(set, inner.set);
      Object.assign(unset, inner.unset);
    } else set[path] = value;
  }
  return { set, unset, paths: [...Object.keys(set), ...Object.keys(unset)] };
}

/**
 * Applies a patch to one gym by id and returns the new view plus field-level changes for the
 * audit log. Callers decide WHICH gym: the host's gym (owner) or a path id (super admin).
 */
export async function patchTenant(
  tenantId: Types.ObjectId | string,
  patch: Record<string, unknown>,
): Promise<{ tenant: TenantView; changes: AuditChange[] }> {
  const before = await Tenant.findById(tenantId).lean<LeanTenant>();
  if (!before) throw Errors.notFound('Gym');
  const { set, unset, paths } = flattenPatch(patch);
  const update: Record<string, unknown> = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;

  const after = await Tenant.findOneAndUpdate({ _id: tenantId }, update, {
    returnDocument: 'after',
    runValidators: true,
  }).lean<LeanTenant>();
  if (!after) throw Errors.notFound('Gym');
  return { tenant: toTenantView(after), changes: diffChanges(before, after, paths) };
}

export async function getTenantView(tenantId: Types.ObjectId | string): Promise<TenantView> {
  const t = await Tenant.findById(tenantId).lean<LeanTenant>();
  if (!t) throw Errors.notFound('Gym');
  return toTenantView(t);
}
