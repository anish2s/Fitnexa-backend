/**
 * Pure host → tenant-candidate parsing. No I/O, fully unit tested.
 *
 *   powerhouse.yourapp.in        → { kind: 'subdomain', slug: 'powerhouse' }
 *   powerhouse.localhost:4000    → { kind: 'subdomain', slug: 'powerhouse' }
 *   yourapp.in / www.yourapp.in  → { kind: 'platform' }
 *   app.powerhousegym.in         → { kind: 'customDomain', domain: 'app.powerhousegym.in' }
 *   a.b.yourapp.in               → { kind: 'invalid' }   (nested subdomains are never tenants)
 */
export type HostResolution =
  | { kind: 'subdomain'; slug: string }
  | { kind: 'customDomain'; domain: string }
  | { kind: 'platform' }
  | { kind: 'invalid' };

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
): HostResolution {
  const host = normalizeHost(rawHost);
  if (!host) return { kind: 'invalid' };
  if (isIpAddress(host)) return { kind: 'platform' };

  // Longest base domain first so "yourapp.co.in" wins over "co.in" if both are configured.
  const bases = [...baseDomains].sort((a, b) => b.length - a.length);
  for (const base of bases) {
    if (host === base) return { kind: 'platform' };
    if (host.endsWith(`.${base}`)) {
      const sub = host.slice(0, -(base.length + 1));
      if (sub.includes('.')) return { kind: 'invalid' };
      if (reservedSubdomains.includes(sub)) return { kind: 'platform' };
      return { kind: 'subdomain', slug: sub };
    }
  }
  return { kind: 'customDomain', domain: host };
}
