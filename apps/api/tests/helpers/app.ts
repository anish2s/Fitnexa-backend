import { Types } from 'mongoose';
import { createApp } from '../../src/app.js';
import { parseEnv, type Env } from '../../src/config/env.js';
import { createLogger } from '../../src/lib/logger.js';
import type { ResolvedTenant, TenantLookup } from '../../src/tenancy/resolver.middleware.js';

export const GYM_A_ID = new Types.ObjectId();
export const GYM_B_ID = new Types.ObjectId();

export const stubTenants: ResolvedTenant[] = [
  {
    id: GYM_A_ID,
    slug: 'powerhouse',
    name: 'Powerhouse Fitness',
    status: 'active',
    branding: {
      primaryColor: '#E11D48',
      logoUrl: 'https://cdn.example/powerhouse.png',
      defaultTheme: 'dark',
    },
  },
  {
    id: GYM_B_ID,
    slug: 'fitzone',
    name: 'FitZone',
    status: 'active',
    branding: { primaryColor: '#0EA5E9', defaultTheme: 'light' },
  },
  {
    id: new Types.ObjectId(),
    slug: 'ironclub',
    name: 'IronClub',
    status: 'suspended',
    branding: {},
  },
  {
    id: new Types.ObjectId(),
    slug: 'closedgym',
    name: 'Closed Gym',
    status: 'archived',
    branding: {},
  },
];

export const stubLookup: TenantLookup = {
  bySlug: async (slug) => stubTenants.find((t) => t.slug === slug) ?? null,
  byCustomDomain: async (domain) => (domain === 'app.powerhousegym.in' ? stubTenants[0]! : null),
};

export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({ ...process.env, ...overrides });
}

export function buildTestApp(
  opts: { env?: Record<string, string>; dbReady?: boolean; lookup?: TenantLookup } = {},
) {
  return createApp({
    env: testEnv(opts.env),
    logger: createLogger('silent'),
    tenantLookup: opts.lookup ?? stubLookup,
    isDbReady: () => opts.dbReady ?? true,
  });
}
