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
  };
}

const FIELDS = '_id slug name status branding';

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
