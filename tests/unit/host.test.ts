import { describe, expect, it } from 'vitest';
import { normalizeHost, resolveHost, siteKindOf } from '../../src/tenancy/host.js';

const BASES = ['yourapp.in', 'localhost'];
const RESERVED = ['www', 'api', 'admin', 'app'];
const r = (h: string | undefined) => resolveHost(h, BASES, RESERVED);

describe('resolveHost', () => {
  it('resolves a gym subdomain on the production domain', () => {
    expect(r('powerhouse.yourapp.in')).toEqual({
      kind: 'subdomain',
      slug: 'powerhouse',
      base: 'gym',
    });
  });

  it('resolves local development subdomains with a port', () => {
    expect(r('fitzone.localhost:4000')).toEqual({
      kind: 'subdomain',
      slug: 'fitzone',
      base: 'gym',
    });
  });

  it('is case-insensitive and tolerates a trailing dot', () => {
    expect(r('PowerHouse.YourApp.IN.')).toEqual({
      kind: 'subdomain',
      slug: 'powerhouse',
      base: 'gym',
    });
  });

  it('treats the bare domain, reserved subdomains and IPs as the platform', () => {
    expect(r('yourapp.in')).toEqual({ kind: 'platform' });
    expect(r('www.yourapp.in')).toEqual({ kind: 'platform' });
    expect(r('admin.localhost:3000')).toEqual({ kind: 'platform' });
    expect(r('127.0.0.1:4000')).toEqual({ kind: 'platform' });
  });

  it('rejects nested subdomains instead of guessing a tenant', () => {
    expect(r('evil.powerhouse.yourapp.in')).toEqual({ kind: 'invalid' });
  });

  it('does not treat look-alike domains as subdomains of the base', () => {
    // "notyourapp.in" ends with "yourapp.in" but is not under it.
    expect(r('notyourapp.in')).toEqual({ kind: 'customDomain', domain: 'notyourapp.in' });
    expect(r('powerhouse.yourapp.in.evil.com')).toEqual({
      kind: 'customDomain',
      domain: 'powerhouse.yourapp.in.evil.com',
    });
  });

  it('passes other hosts through as custom-domain candidates', () => {
    expect(r('app.powerhousegym.in')).toEqual({
      kind: 'customDomain',
      domain: 'app.powerhousegym.in',
    });
  });

  it('rejects malformed hosts', () => {
    for (const bad of [
      undefined,
      '',
      'power_house.yourapp.in',
      '-gym.yourapp.in',
      '[::1]:4000',
      'a..b',
    ]) {
      expect(r(bad)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('normalizeHost', () => {
  it('strips port and lowercases', () => {
    expect(normalizeHost('Gym.Localhost:3000')).toBe('gym.localhost');
  });
});

describe('staff addresses (STAFF_BASE_DOMAINS)', () => {
  const STAFF = ['staff.localhost', 'staff.yourapp.in'];
  const rs = (h: string) => resolveHost(h, BASES, RESERVED, STAFF);

  it('the longest matching base wins: <slug>.staff.<base> is the staff site of that gym', () => {
    expect(rs('powerhouse.staff.localhost:3001')).toEqual({
      kind: 'subdomain',
      slug: 'powerhouse',
      base: 'staff',
    });
    expect(rs('powerhouse.staff.yourapp.in')).toEqual({
      kind: 'subdomain',
      slug: 'powerhouse',
      base: 'staff',
    });
    expect(rs('powerhouse.localhost')).toEqual({
      kind: 'subdomain',
      slug: 'powerhouse',
      base: 'gym',
    });
  });

  it('the bare staff base and reserved names are the platform; deeper names are invalid', () => {
    expect(rs('staff.localhost')).toEqual({ kind: 'platform' });
    expect(rs('admin.staff.yourapp.in')).toEqual({ kind: 'platform' });
    expect(rs('a.powerhouse.staff.localhost')).toEqual({ kind: 'invalid' });
  });

  it('site kinds: split only when staff bases are configured; custom domains are member sites', () => {
    expect(siteKindOf(rs('powerhouse.staff.localhost'), true)).toBe('staff');
    expect(siteKindOf(rs('powerhouse.localhost'), true)).toBe('member');
    expect(siteKindOf(rs('app.powerhousegym.in'), true)).toBe('member');
    expect(siteKindOf(r('powerhouse.localhost'), false)).toBe('any');
  });
});

describe("owner's layout (2026-11-20): members on <gym>.pwa.<domain>, staff on the main <gym>.<domain>", () => {
  // BASE_DOMAINS = the member addresses, STAFF_BASE_DOMAINS = the staff (main) addresses.
  const MEMBER = ['pwa.yourapp.in', 'pwa.localhost'];
  const STAFF = ['yourapp.in', 'localhost'];
  const RES = ['www', 'api', 'app', 'admin', 'platform', 'pwa', 'staff'];
  const rl = (h: string) => resolveHost(h, MEMBER, RES, STAFF);

  it('the member app is <gym>.pwa.<domain>; the staff dashboard keeps <gym>.<domain>', () => {
    expect(rl('powerhouse.pwa.yourapp.in')).toEqual({
      kind: 'subdomain',
      slug: 'powerhouse',
      base: 'gym',
    });
    expect(siteKindOf(rl('powerhouse.pwa.yourapp.in'), true)).toBe('member');
    expect(rl('powerhouse.yourapp.in')).toEqual({
      kind: 'subdomain',
      slug: 'powerhouse',
      base: 'staff',
    });
    expect(siteKindOf(rl('powerhouse.yourapp.in'), true)).toBe('staff');
    expect(siteKindOf(rl('powerhouse.pwa.localhost:3005'), true)).toBe('member');
    expect(siteKindOf(rl('powerhouse.localhost:3001'), true)).toBe('staff');
  });

  it('the platform console and the bare names are the platform; "pwa" can never be a gym', () => {
    expect(rl('admin.yourapp.in')).toEqual({ kind: 'platform' });
    expect(rl('admin.localhost')).toEqual({ kind: 'platform' });
    expect(rl('yourapp.in')).toEqual({ kind: 'platform' });
    expect(rl('pwa.yourapp.in')).toEqual({ kind: 'platform' });
    expect(rl('a.powerhouse.pwa.yourapp.in')).toEqual({ kind: 'invalid' });
  });
});
