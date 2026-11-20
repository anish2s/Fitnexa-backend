import type { ResolvedTenant, TenantLookup } from '../../tenancy/resolver.middleware.js';
import { Tenant, type TenantAttrs } from './tenant.model.js';

type LeanTenant = TenantAttrs & { _id: ResolvedTenant['id'] };

function toResolved(t: LeanTenant | null): ResolvedTenant | null {
  if (!t) return null;
  return {
    id: t._id,
    slug: t.slug,
    name: t.name,
    status: t.status as ResolvedTenant['status'],
    branding: (t.branding ?? {}) as Record<string, unknown>,
    contact: contactOf(t),
  };
}

/** Public business contact: phone, street address (line 1 + line 2) and city; nulls when unset. */
export function contactOf(
  t: Pick<LeanTenant, 'phone' | 'address'>,
): NonNullable<ResolvedTenant['contact']> {
  const a = t.address ?? {};
  const street = [a.line1, a.line2]
    .map((v) => v?.trim())
    .filter(Boolean)
    .join(', ');
  return { phone: t.phone?.trim() || null, address: street || null, city: a.city?.trim() || null };
}

const FIELDS = '_id slug name status branding phone address';

/**
 * Database-backed tenant lookup. Runs on every tenant request; served by the unique indexes on
 * slug and customDomain. If it ever shows up in profiles, add a small in-process TTL cache here
 * (no Redis needed at this scale).
 */
export const mongoTenantLookup: TenantLookup = {
  async bySlug(slug) {
    return toResolved(await Tenant.findOne({ slug }).select(FIELDS).lean<LeanTenant>());
  },
  async byCustomDomain(domain) {
    return toResolved(
      await Tenant.findOne({ customDomain: domain, customDomainVerified: true })
        .select(FIELDS)
        .lean<LeanTenant>(),
    );
  },
};
