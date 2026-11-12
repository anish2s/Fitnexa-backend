import { describe, expect, it } from 'vitest';
import { normalizeHost, resolveHost } from '../../src/tenancy/host.js';

const BASES = ['yourapp.in', 'localhost'];
const RESERVED = ['www', 'api', 'admin', 'app'];
const r = (h: string | undefined) => resolveHost(h, BASES, RESERVED);

describe('resolveHost', () => {
  it('resolves a gym subdomain on the production domain', () => {
    expect(r('powerhouse.yourapp.in')).toEqual({ kind: 'subdomain', slug: 'powerhouse' });
  });

  it('resolves local development subdomains with a port', () => {
    expect(r('fitzone.localhost:4000')).toEqual({ kind: 'subdomain', slug: 'fitzone' });
  });

  it('is case-insensitive and tolerates a trailing dot', () => {
    expect(r('PowerHouse.YourApp.IN.')).toEqual({ kind: 'subdomain', slug: 'powerhouse' });
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
