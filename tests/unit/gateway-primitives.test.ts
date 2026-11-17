import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { openSecret, sealSecret } from '../../src/lib/secret-box.js';
import {
  RazorpayError,
  httpRazorpayClient,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from '../../src/modules/payments/razorpay.client.js';

describe('secret box (AES-256-GCM)', () => {
  const key = randomBytes(32);
  it('round-trips and never contains the plaintext', () => {
    const sealed = sealSecret('s3cretKeyValue123', key, 'gymA:razorpay:keySecret');
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('s3cretKeyValue123');
    expect(openSecret(sealed, key, 'gymA:razorpay:keySecret')).toBe('s3cretKeyValue123');
    expect(sealSecret('same', key, 'a')).not.toBe(sealSecret('same', key, 'a')); // random IV
  });
  it('refuses a tampered value, another gym (AAD), or another master key', () => {
    const sealed = sealSecret('value', key, 'gymA');
    const parts = sealed.split('.');
    const flipped = parts[3]!.startsWith('A') ? 'B' + parts[3]!.slice(1) : 'A' + parts[3]!.slice(1);
    expect(() =>
      openSecret([parts[0], parts[1], parts[2], flipped].join('.'), key, 'gymA'),
    ).toThrow();
    expect(() => openSecret(sealed, key, 'gymB')).toThrow();
    expect(() => openSecret(sealed, randomBytes(32), 'gymA')).toThrow();
    expect(() => openSecret('v2.x.y.z', key, 'gymA')).toThrow(/format/);
  });
});

describe('Razorpay signatures', () => {
  const secret = 'testKeySecret1234567890';
  const sig = (s: string, k = secret) => createHmac('sha256', k).update(s).digest('hex');

  it('checkout: HMAC(order_id|payment_id) with the key secret', () => {
    const good = sig('order_ABC123|pay_XYZ789');
    expect(verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', good, secret)).toBe(true);
    expect(verifyCheckoutSignature('order_ABC123', 'pay_OTHER1', good, secret)).toBe(false);
    expect(verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', good, 'otherSecret')).toBe(false);
    expect(verifyCheckoutSignature('order_ABC123', 'pay_XYZ789', 'short', secret)).toBe(false);
  });
  it('webhook: HMAC over the exact raw body', () => {
    const body = Buffer.from('{"event":"payment.captured","x":1}');
    const good = sig(body.toString(), 'whsec');
    expect(verifyWebhookSignature(body, good, 'whsec')).toBe(true);
    // Same JSON, different bytes (spacing): must fail. Signatures are over bytes, not meaning.
    expect(
      verifyWebhookSignature(Buffer.from('{"event": "payment.captured","x":1}'), good, 'whsec'),
    ).toBe(false);
  });
});

describe('httpRazorpayClient', () => {
  const creds = { keyId: 'rzp_test_abcdefgh', keySecret: 'secretsecretsecret' };
  it('creates orders with basic auth, INR and integer paise', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: 'order_1', amount: 150000, currency: 'INR', status: 'created' }),
        ),
    );
    const order = await httpRazorpayClient({ fetch: f as unknown as typeof fetch }).createOrder(
      creds,
      {
        amountPaise: 150000,
        receipt: 'ms_1',
        notes: { a: 'b' },
      },
    );
    expect(order.id).toBe('order_1');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/orders');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + Buffer.from('rzp_test_abcdefgh:secretsecretsecret').toString('base64'),
    );
    expect(JSON.parse(init.body as string)).toEqual({
      amount: 150000,
      currency: 'INR',
      receipt: 'ms_1',
      notes: { a: 'b' },
    });
  });
  it('maps Razorpay errors and network failures to RazorpayError', async () => {
    const bad = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'BAD_REQUEST_ERROR', description: 'The amount is invalid' },
          }),
          { status: 400 },
        ),
    );
    const err = await httpRazorpayClient({ fetch: bad as unknown as typeof fetch })
      .refund(creds, { paymentId: 'pay_1', amountPaise: 1, notes: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RazorpayError);
    expect(err).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST_ERROR',
      message: 'The amount is invalid',
    });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      httpRazorpayClient({ fetch: down as unknown as typeof fetch }).createOrder(creds, {
        amountPaise: 100,
        receipt: 'r',
        notes: {},
      }),
    ).rejects.toThrow(/Could not reach Razorpay/);
  });
});
