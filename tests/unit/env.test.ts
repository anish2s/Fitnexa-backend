import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.js';

const base = {
  MONGODB_URI: 'mongodb://x/y',
  BASE_DOMAINS: 'yourapp.in, LocalHost',
  JWT_ACCESS_SECRET: 'x'.repeat(48),
};

describe('parseEnv', () => {
  it('applies defaults and normalises lists', () => {
    const env = parseEnv(base);
    expect(env.PORT).toBe(4000);
    expect(env.BASE_DOMAINS).toEqual(['yourapp.in', 'localhost']);
    expect(env.RESERVED_SUBDOMAINS).toContain('www');
    expect(env.ALLOW_TENANT_HEADER).toBe(false);
  });

  it('fails fast when required values are missing', () => {
    expect(() => parseEnv({})).toThrow(/MONGODB_URI/);
    expect(() => parseEnv({ MONGODB_URI: 'mongodb://x' })).toThrow(/BASE_DOMAINS/);
  });

  it('forbids the tenant-header fallback in production', () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://*.yourapp.in',
        ALLOW_TENANT_HEADER: 'true',
      }),
    ).toThrow(/ALLOW_TENANT_HEADER/);
  });

  it('requires explicit CORS origins in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).toThrow(/CORS_ORIGINS/);
  });

  it('requires a long JWT secret', () => {
    expect(() => parseEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('defaults secure cookies on in production, off in development', () => {
    expect(parseEnv(base).COOKIE_SECURE).toBe(false);
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(
      /COOKIE_SECURE/,
    );
  });

  it('refuses dev-only email transports and plain-http links in production', () => {
    const prod = { ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://*.yourapp.in' };
    expect(() => parseEnv(prod)).toThrow(/MAIL_TRANSPORT/);
    expect(() => parseEnv(prod)).toThrow(/GYM_APP_URL_TEMPLATE/);
  });
});
