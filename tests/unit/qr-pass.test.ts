import { describe, expect, it } from 'vitest';
import {
  PASS_WINDOW_SEC,
  createPassSigner,
  qrMasterSecret,
} from '../../src/modules/attendance/qr-pass.js';

const signer = createPassSigner('x'.repeat(48));
const GYM_A = '64b000000000000000000001';
const GYM_B = '64b000000000000000000002';
const MEMBER = '65c0000000000000000000aa';
const T0 = Date.UTC(2026, 10, 17, 6, 0, 0); // window boundary
const W = PASS_WINDOW_SEC * 1000;

describe('QR pass', () => {
  it('issues a short token that verifies for that gym and member', () => {
    const p = signer.issue(GYM_A, MEMBER, T0 + 1000);
    expect(p.token).toMatch(/^gp1\.[a-f0-9]{24}\.[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
    expect(p.token.length).toBeLessThan(70);
    expect(p.refreshAt.getTime()).toBe(T0 + W);
    expect(p.validUntil.getTime()).toBe(T0 + 3 * W);
    expect(signer.verify(GYM_A, p.token, T0 + 2000)).toEqual({ ok: true, memberId: MEMBER });
  });

  it('accepts two windows back and one ahead; nothing outside', () => {
    const { token } = signer.issue(GYM_A, MEMBER, T0);
    expect(signer.verify(GYM_A, token, T0 + 2 * W + W - 1).ok).toBe(true); // 2 windows later, last ms
    expect(signer.verify(GYM_A, token, T0 + 3 * W)).toEqual({ ok: false, reason: 'expired' });
    expect(signer.verify(GYM_A, token, T0 - W).ok).toBe(true); // phone clock 1 window ahead
    expect(signer.verify(GYM_A, token, T0 - 2 * W)).toEqual({ ok: false, reason: 'expired' });
  });

  it("another gym, another member or a tampered window doesn't verify", () => {
    const { token } = signer.issue(GYM_A, MEMBER, T0);
    expect(signer.verify(GYM_B, token, T0)).toEqual({ ok: false, reason: 'bad_signature' });
    const [p, , w, sig] = token.split('.');
    expect(signer.verify(GYM_A, [p, '65c0000000000000000000bb', w, sig].join('.'), T0).ok).toBe(
      false,
    );
    // Moving the window forward to extend a screenshot's life breaks the signature.
    const later = (parseInt(w!, 36) + 10).toString(36);
    expect(signer.verify(GYM_A, [p, MEMBER, later, sig].join('.'), T0 + 10 * W)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(createPassSigner('y'.repeat(48)).verify(GYM_A, token, T0).ok).toBe(false);
  });

  it('rejects malformed input', () => {
    for (const t of [
      '',
      'hello',
      'gp2.a.b.c',
      `gp1.${MEMBER}.zz`,
      `gp1.NOTHEX${MEMBER.slice(6)}.1.${'a'.repeat(22)}`,
      `gp1.${MEMBER}.1.short`,
    ]) {
      expect(signer.verify(GYM_A, t, T0)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('master secret: explicit when set, otherwise derived (not the JWT secret itself)', () => {
    const jwt = 'j'.repeat(48);
    expect(qrMasterSecret({ JWT_ACCESS_SECRET: jwt, QR_SIGNING_SECRET: 'q'.repeat(32) })).toBe(
      'q'.repeat(32),
    );
    const derived = qrMasterSecret({ JWT_ACCESS_SECRET: jwt });
    expect(derived).not.toBe(jwt);
    expect(derived).toBe(qrMasterSecret({ JWT_ACCESS_SECRET: jwt }));
  });
});
