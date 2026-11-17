import type { RequestHandler } from 'express';
import type { Types } from 'mongoose';
import { Errors } from '../lib/errors.js';
import { runInTenant } from './context.js';
import { resolveHost } from './host.js';

/** Minimal tenant shape the request pipeline needs. */
export interface ResolvedTenant {
  id: Types.ObjectId;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'archived';
  branding: Record<string, unknown>;
}

export interface TenantLookup {
  bySlug(slug: string): Promise<ResolvedTenant | null>;
  byCustomDomain(domain: string): Promise<ResolvedTenant | null>;
}

export interface ResolverOptions {
  lookup: TenantLookup;
  baseDomains: readonly string[];
  reservedSubdomains: readonly string[];
  /** Dev only: honor X-Tenant-Slug. Config validation forbids this in production. */
  allowTenantHeader: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by resolveTenant(); undefined on platform hosts (yourapp.in, www, admin). */
    tenant?: ResolvedTenant;
  }
}

/**
 * Identifies the gym from the request host and opens a tenant scope for the rest of the request.
 *
 * The tenant comes only from the host (or, in development, an explicit header). Body, query and
 * route params are never consulted. authenticate() then requires that the token's
 * tenant equals req.tenant, so a Gym B token presented on Gym A's host is rejected.
 */
export function resolveTenant(opts: ResolverOptions): RequestHandler {
  return async (req, _res, next) => {
    const headerSlug = opts.allowTenantHeader
      ? req.get('x-tenant-slug')?.trim().toLowerCase()
      : undefined;

    let tenant: ResolvedTenant | null = null;
    if (headerSlug) {
      tenant = await opts.lookup.bySlug(headerSlug);
      if (!tenant) throw Errors.tenantNotFound();
    } else {
      // req.hostname honours X-Forwarded-Host only when "trust proxy" is configured.
      const resolution = resolveHost(req.hostname, opts.baseDomains, opts.reservedSubdomains);
      switch (resolution.kind) {
        case 'platform':
          return next();
        case 'invalid':
          throw Errors.badRequest('Invalid host');
        case 'subdomain':
          tenant = await opts.lookup.bySlug(resolution.slug);
          break;
        case 'customDomain':
          tenant = await opts.lookup.byCustomDomain(resolution.domain);
          break;
      }
      if (!tenant) throw Errors.tenantNotFound();
    }

    if (tenant.status === 'archived') throw Errors.tenantNotFound();
    req.tenant = tenant;
    // Everything downstream (including async continuations) runs inside this tenant's scope.
    await runInTenant(tenant.id, () => next());
  };
}

/** For routes that only make sense on a gym domain (all gym business endpoints). */
export const requireTenant: RequestHandler = (req, _res, next) => {
  if (!req.tenant) throw Errors.tenantRequired();
  next();
};

/** Blocks business operations for suspended gyms; branding/login pages can still load. */
export const requireActiveTenant: RequestHandler = (req, _res, next) => {
  if (!req.tenant) throw Errors.tenantRequired();
  if (req.tenant.status !== 'active') throw Errors.tenantSuspended();
  next();
};
