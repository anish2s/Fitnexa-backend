import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken, InvalidTokenError } from '../../src/auth/jwt.js';
import { hashPassword, needsRehash, verifyPassword } from '../../src/auth/password.js';
import {
  effectivePermissions,
  ROLE_PERMISSIONS,
  STAFF_GRANTABLE,
  type Permission,
} from '../../src/auth/permissions.js';
import { hashToken, isWellFormedToken, randomToken } from '../../src/auth/tokens.js';
import { normalizePhone } from '../../src/lib/phone.js';
import { authorize, type AuthContext } from '../../src/middleware/authenticate.js';
import { errorHandler } from '../../src/middleware/error-handler.js';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterY', h)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects malformed hashes and absurdly long inputs without throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x'.repeat(10_000), await hashPassword('x'))).toBe(false);
  });

  it('flags weaker parameters for upgrade', () => {
    expect(needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('bcrypt$whatever')).toBe(true);
  });
});

describe('opaque tokens', () => {
  it('are 256-bit, URL-safe, and stored only as a hash', () => {
    const t = randomToken();
    expect(isWellFormedToken(t)).toBe(true);
    expect(hashToken(t)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(t)).not.toContain(t);
    expect(randomToken()).not.toBe(t);
  });

  it('rejects anything that is not token-shaped', () => {
    for (const bad of [
      undefined,
      42,
      '',
      'short',
      'a'.repeat(44),
      "'; drop table --".padEnd(43, 'a'),
    ]) {
      expect(isWellFormedToken(bad)).toBe(false);
    }
  });
});

describe('access tokens', () => {
  const cfg = { secret: 's'.repeat(48), issuer: 'test', ttlSec: 900 };

  it('round-trips tenant and platform claims', async () => {
    const t = await signAccessToken(cfg, {
      typ: 'tenant',
      sub: 'u1',
      sid: 's1',
      tid: 'g1',
      role: 'staff',
    });
    expect(await verifyAccessToken(cfg, t)).toEqual({
      typ: 'tenant',
      sub: 'u1',
      sid: 's1',
      tid: 'g1',
      role: 'staff',
    });
    const p = await signAccessToken(cfg, {
      typ: 'platform',
      sub: 'a1',
      sid: 's2',
      role: 'super_admin',
    });
    expect((await verifyAccessToken(cfg, p)).typ).toBe('platform');
  });

  it('rejects another key, another issuer, or a mangled token', async () => {
    const t = await signAccessToken(cfg, {
      typ: 'tenant',
      sub: 'u',
      sid: 's',
      tid: 'g',
      role: 'owner',
    });
    await expect(verifyAccessToken({ ...cfg, secret: 'k'.repeat(48) }, t)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    await expect(verifyAccessToken({ ...cfg, issuer: 'other' }, t)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    await expect(verifyAccessToken(cfg, t.slice(0, -2))).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe('permissions', () => {
  it('owners hold every gym permission; members only self-service', () => {
    expect(ROLE_PERMISSIONS.owner).toContain('staff:manage');
    expect(ROLE_PERMISSIONS.owner).not.toContain('self:read');
    expect([...effectivePermissions('member')]).toEqual(['self:read', 'self:update', 'self:pay']);
  });

  it('staff grants are limited to the grantable list', () => {
    const p = effectivePermissions('staff', [
      'reports:read',
      'staff:manage',
      'branding:update',
      'nonsense',
    ]);
    expect(p.has('reports:read')).toBe(true);
    expect(p.has('staff:manage')).toBe(false);
    expect(p.has('branding:update')).toBe(false);
  });

  it('grants never apply to members', () => {
    expect(effectivePermissions('member', [...STAFF_GRANTABLE]).has('reports:read')).toBe(false);
  });
});

describe('authorize middleware', () => {
  function appWith(auth: AuthContext | undefined, ...perms: Permission[]) {
    const app = express();
    app.use((req, _res, next) => {
      req.auth = auth;
      next();
    });
    app.get('/x', authorize(...perms), (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    return app;
  }
  const staff: AuthContext = {
    kind: 'tenant',
    userId: 'u',
    name: 'Staff',
    sessionId: 's',
    role: 'staff',
    tenantId: 'g',
    permissions: effectivePermissions('staff'),
  };

  it('allows when every permission is held', async () => {
    expect(
      (await request(appWith(staff, 'members:read', 'payments:record')).get('/x')).status,
    ).toBe(200);
  });
  it('403s when any is missing, 401s with no auth, 403s for super admins on gym routes', async () => {
    expect((await request(appWith(staff, 'members:read', 'reports:read')).get('/x')).status).toBe(
      403,
    );
    expect((await request(appWith(undefined, 'members:read')).get('/x')).status).toBe(401);
    const admin: AuthContext = {
      kind: 'platform',
      userId: 'a',
      name: 'Admin',
      sessionId: 's',
      role: 'super_admin',
    };
    expect((await request(appWith(admin, 'members:read')).get('/x')).status).toBe(403);
  });
});

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['+447700900123', '+447700900123'],
  ])('%s → %s', (input, out) => expect(normalizePhone(input)).toBe(out));

  it.each(['abc', '123', '+0123456789', ''])('rejects %s', (input) =>
    expect(normalizePhone(input)).toBeNull(),
  );
});
