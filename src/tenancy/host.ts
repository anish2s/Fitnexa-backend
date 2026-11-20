/**
 * Pure host → tenant-candidate parsing. No I/O, fully unit tested.
 *
 *   powerhouse.yourapp.in        → { kind: 'subdomain', slug: 'powerhouse', base: 'gym' }
 *   powerhouse.localhost:4000    → { kind: 'subdomain', slug: 'powerhouse', base: 'gym' }
 *   powerhouse.staff.yourapp.in  → { kind: 'subdomain', slug: 'powerhouse', base: 'staff' }
 *                                  (with "staff.yourapp.in" in STAFF_BASE_DOMAINS)
 *   yourapp.in / www.yourapp.in  → { kind: 'platform' }
 *   app.powerhousegym.in         → { kind: 'customDomain', domain: 'app.powerhousegym.in' }
 *   a.b.yourapp.in               → { kind: 'invalid' }   (nested subdomains are never tenants)
 */
export type HostResolution =
  | { kind: 'subdomain'; slug: string; base: 'gym' | 'staff' }
  | { kind: 'customDomain'; domain: string }
  | { kind: 'platform' }
  | { kind: 'invalid' };

/**
 * Which app a gym request is for (Phase 3: members and staff on separate addresses).
 *  - `member`: the gym's main address while a staff address is configured;
 *  - `staff`: the staff dashboard's address;
 *  - `any`: no staff address configured: the main address serves everyone (pre-Phase-3 behaviour).
 */
export type SiteKind = 'member' | 'staff' | 'any';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeHost(rawHost: string | undefined): string | null {
  if (!rawHost) return null;
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith('[')) return null; // IPv6 literal: never a tenant
  host = host.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host || host.length > 253) return null;
  const labels = host.split('.');
  if (!labels.every((l) => LABEL.test(l))) return null;
  return host;
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export function resolveHost(
  rawHost: string | undefined,
  baseDomains: readonly string[],
  reservedSubdomains: readonly string[],
  staffBaseDomains: readonly string[] = [],
): HostResolution {
  const host = normalizeHost(rawHost);
  if (!host) return { kind: 'invalid' };
  if (isIpAddress(host)) return { kind: 'platform' };

  // Longest base domain first, across gym and staff bases: "staff.localhost" wins over "localhost"
  // (powerhouse.staff.localhost is the staff site of "powerhouse", not a gym called
  // "powerhouse.staff"), and "yourapp.co.in" over "co.in".
  const bases = [
    ...baseDomains.map((d) => ({ d, base: 'gym' as const })),
    ...staffBaseDomains.map((d) => ({ d, base: 'staff' as const })),
  ].sort((a, b) => b.d.length - a.d.length);
  for (const { d, base } of bases) {
    if (host === d) return { kind: 'platform' };
    if (host.endsWith(`.${d}`)) {
      const sub = host.slice(0, -(d.length + 1));
      if (sub.includes('.')) return { kind: 'invalid' };
      if (reservedSubdomains.includes(sub)) return { kind: 'platform' };
      return { kind: 'subdomain', slug: sub, base };
    }
  }
  return { kind: 'customDomain', domain: host };
}

/**
 * The site kind of a gym host. Custom domains are the gym's own member-facing address (the staff
 * dashboard always lives under a staff base domain once one is configured).
 */
export function siteKindOf(resolution: HostResolution, staffSplit: boolean): SiteKind {
  if (!staffSplit) return 'any';
  if (resolution.kind === 'subdomain' && resolution.base === 'staff') return 'staff';
  return 'member';
}
