import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal Razorpay REST client (no SDK). Credentials are passed per call: every gym has its own.
 * Tests inject a fake; no test talks to Razorpay.
 */
export interface RazorpayCreds {
  keyId: string;
  keySecret: string;
}
export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}
export interface RazorpayRefund {
  id: string;
  amount: number;
  status: 'pending' | 'processed' | 'failed';
}

export interface RazorpayClient {
  createOrder(
    creds: RazorpayCreds,
    o: { amountPaise: number; receipt: string; notes: Record<string, string> },
  ): Promise<RazorpayOrder>;
  refund(
    creds: RazorpayCreds,
    r: { paymentId: string; amountPaise: number; notes: Record<string, string> },
  ): Promise<RazorpayRefund>;
}

export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

export function httpRazorpayClient(
  opts: { fetch?: typeof fetch; baseUrl?: string } = {},
): RazorpayClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? 'https://api.razorpay.com/v1';

  async function post<T>(creds: RazorpayCreds, path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new RazorpayError('Could not reach Razorpay');
    }
    const json = (await res.json().catch(() => ({}))) as T & {
      error?: { code?: string; description?: string };
    };
    if (!res.ok) {
      throw new RazorpayError(
        json.error?.description ?? `Razorpay error ${res.status}`,
        res.status,
        json.error?.code,
      );
    }
    return json;
  }

  return {
    createOrder: (creds, o) =>
      post<RazorpayOrder>(creds, '/orders', {
        amount: o.amountPaise,
        currency: 'INR',
        receipt: o.receipt,
        notes: o.notes,
      }),
    refund: (creds, r) =>
      post<RazorpayRefund>(creds, `/payments/${encodeURIComponent(r.paymentId)}/refund`, {
        amount: r.amountPaise,
        notes: r.notes,
      }),
  };
}

const hmacHex = (data: string | Buffer, secret: string) =>
  createHmac('sha256', secret).update(data).digest('hex');

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Checkout success: signature = HMAC-SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  return safeEqualHex(hmacHex(`${orderId}|${paymentId}`, keySecret), signature);
}

/** Webhooks: X-Razorpay-Signature = HMAC-SHA256(raw body, webhook secret). */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string,
  webhookSecret: string,
): boolean {
  return safeEqualHex(hmacHex(rawBody, webhookSecret), signature);
}
