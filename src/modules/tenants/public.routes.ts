import { Router } from 'express';
import { ok } from '../../lib/response.js';
import { requireTenant } from '../../tenancy/resolver.middleware.js';

/**
 * Unauthenticated, tenant-scoped endpoints. The dashboard and PWA call these before login to
 * paint the gym's logo, colours and theme. Only explicitly whitelisted fields are returned.
 */
export function publicTenantRouter() {
  const router = Router();

  router.get('/tenant', requireTenant, (req, res) => {
    const t = req.tenant!;
    const b = t.branding as {
      logoUrl?: string;
      appIconUrl?: string;
      coverImageUrl?: string;
      primaryColor?: string;
      secondaryColor?: string;
      defaultTheme?: string;
      updatedAt?: Date;
    };
    // Cacheable briefly at the edge; branding changes are rare and not sensitive.
    res.set('Cache-Control', 'public, max-age=60');
    ok(res, {
      name: t.name,
      slug: t.slug,
      status: t.status === 'active' ? 'active' : 'suspended',
      /** Which app this address is for: member, staff, or any (no separate staff address). */
      site: req.site ?? 'any',
      branding: {
        logoUrl: b.logoUrl ?? null,
        appIconUrl: b.appIconUrl ?? null,
        /** Member-app hero photo; null = the app draws a pattern in the gym colour. */
        coverImageUrl: b.coverImageUrl ?? null,
        primaryColor: b.primaryColor ?? '#7C3AED',
        secondaryColor: b.secondaryColor ?? '#0F172A',
        defaultTheme: b.defaultTheme ?? 'dark',
        /** Changes whenever branding does; clients use it to version icon URLs. */
        updatedAt: b.updatedAt ?? null,
      },
      /** Business contact only (signed-out safe): the member app shows the gym's area and phone. */
      contact: t.contact ?? { phone: null, address: null, city: null },
    });
  });

  return router;
}
