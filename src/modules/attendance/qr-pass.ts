import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Rotating member pass for the QR code in the member app.
 *
 *   token = "gp1.<memberId>.<window base36>.<sig>"
 *   sig   = HMAC-SHA256(gymKey, "<memberId>|<window>") truncated to 16 bytes, base64url
 *   gymKey = HKDF(master, salt = tenantId): every gym signs with its own key, so a Powerhouse pass
 *            is meaningless at FitZone.
 *
 * Windows are 30 s; a scan accepts the current window, two before (scan delay, slow phones) and one
 * after (clock skew): a pass is good for ~60–90 s, so a screenshot is soon useless. Same-day replay
 * is harmless anyway: one check-in per member per day.
 */
export const PASS_WINDOW_SEC = 30;
const ACCEPT_PAST = 2;
const ACCEPT_FUTURE = 1;
const PREFIX = 'gp1';

export type PassResult =
  { ok: true; memberId: string } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function createPassSigner(masterSecret: string) {
  const master = Buffer.from(masterSecret, 'utf8');
  const keys = new Map<string, Buffer>();

  const gymKey = (tenantId: string) => {
    let k = keys.get(tenantId);
    if (!k) {
      k = Buffer.from(hkdfSync('sha256', master, Buffer.from(tenantId), 'attendance-qr-v1', 32));
      keys.set(tenantId, k);
    }
    return k;
  };
  const sign = (tenantId: string, memberId: string, window: number) =>
    createHmac('sha256', gymKey(tenantId))
      .update(`${memberId}|${window}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  const windowAt = (ms: number) => Math.floor(ms / 1000 / PASS_WINDOW_SEC);

  function issue(tenantId: string, memberId: string, now = Date.now()) {
    const window = windowAt(now);
    return {
      token: `${PREFIX}.${memberId}.${window.toString(36)}.${sign(tenantId, memberId, window)}`,
      /** When the app should fetch a fresh pass. */
      refreshAt: new Date((window + 1) * PASS_WINDOW_SEC * 1000),
      /** Last moment a scanner will accept it. */
      validUntil: new Date((window + 1 + ACCEPT_PAST) * PASS_WINDOW_SEC * 1000),
    };
  }

  function verify(tenantId: string, token: string, now = Date.now()): PassResult {
    const parts = token.trim().split('.');
    if (parts.length !== 4 || parts[0] !== PREFIX) return { ok: false, reason: 'malformed' };
    const [, memberId, w36, sig] = parts as [string, string, string, string];
    if (
      !/^[a-f0-9]{24}$/.test(memberId) ||
      !/^[0-9a-z]{1,12}$/.test(w36) ||
      !/^[A-Za-z0-9_-]{22}$/.test(sig)
    ) {
      return { ok: false, reason: 'malformed' };
    }
    const window = parseInt(w36, 36);
    const expected = Buffer.from(sign(tenantId, memberId, window));
    const given = Buffer.from(sig);
    // Signature first: an attacker learns nothing about timing windows from forged tokens.
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return { ok: false, reason: 'bad_signature' };
    }
    const current = windowAt(now);
    if (window < current - ACCEPT_PAST || window > current + ACCEPT_FUTURE) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, memberId };
  }

  return { issue, verify };
}

export type PassSigner = ReturnType<typeof createPassSigner>;

/** Explicit QR secret, or one derived from the JWT secret (domain-separated). */
export function qrMasterSecret(env: { QR_SIGNING_SECRET?: string; JWT_ACCESS_SECRET: string }) {
  if (env.QR_SIGNING_SECRET) return env.QR_SIGNING_SECRET;
  return createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update('attendance-qr-master-v1')
    .digest('base64');
}
