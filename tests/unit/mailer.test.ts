import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import { createLogger } from '../../src/lib/logger.js';
import {
  MailSendError,
  createMailer,
  resendMailer,
  type MailMessage,
} from '../../src/lib/mailer.js';

const logger = createLogger('silent');
const msg: MailMessage = {
  to: 'arjun@member.demo',
  subject: 'Your sign-in link',
  text: 'https://powerhouse.yourapp.in/login/verify?token=secret',
  kind: 'magic_link',
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('resendMailer', () => {
  it('posts one email to the Resend API with the key, sender and a kind tag', async () => {
    const f = fakeFetch(200, { id: 'email_123' });
    const info = vi.spyOn(logger, 'info');
    await resendMailer({
      apiKey: 're_test_key',
      from: 'Gym <no-reply@yourapp.in>',
      logger,
      fetch: f,
    }).send(msg);

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'Gym <no-reply@yourapp.in>',
      to: ['arjun@member.demo'],
      subject: 'Your sign-in link',
      text: msg.text,
      tags: [{ name: 'kind', value: 'magic_link' }],
    });
    // Success log has the provider id, never the recipient or the link.
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain('email_123');
    expect(logged).not.toContain('arjun@member.demo');
    expect(logged).not.toContain('token=');
  });

  it('throws MailSendError on a provider rejection without echoing the recipient', async () => {
    const f = fakeFetch(422, {
      name: 'validation_error',
      message: 'Invalid `to` field: arjun@member.demo',
    });
    const err = await resendMailer({ apiKey: 're_k', from: 'a@b.in', logger, fetch: f })
      .send(msg)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect(err).toMatchObject({ status: 422, providerCode: 'validation_error' });
    expect(String((err as Error).message)).not.toContain('arjun');
  });

  it('throws MailSendError on network failure and on timeout', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      resendMailer({ apiKey: 're_k', from: 'a@b.in', logger, fetch: down }).send(msg),
    ).rejects.toThrow(/Resend request failed/);

    const slow = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_r, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    );
    await expect(
      resendMailer({ apiKey: 're_k', from: 'a@b.in', logger, fetch: slow, timeoutMs: 20 }).send(
        msg,
      ),
    ).rejects.toThrow(/timed out/);
  });
});

describe('mail config', () => {
  const base = {
    MONGODB_URI: 'mongodb://x/y',
    BASE_DOMAINS: 'yourapp.in',
    JWT_ACCESS_SECRET: 'x'.repeat(48),
  };
  const prod = {
    ...base,
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://*.yourapp.in',
    GYM_APP_URL_TEMPLATE: 'https://{slug}.yourapp.in',
  };

  it('resend needs an API key and a non-localhost sender', () => {
    expect(() => parseEnv({ ...base, MAIL_TRANSPORT: 'resend' })).toThrow(/RESEND_API_KEY/);
    expect(() =>
      parseEnv({ ...base, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_abcdefgh123' }),
    ).toThrow(/MAIL_FROM/);
  });

  it('production boots with resend configured', () => {
    const env = parseEnv({
      ...prod,
      MAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 're_abcdefgh123',
      MAIL_FROM: 'Gym App <no-reply@yourapp.in>',
    });
    expect(env.MAIL_TRANSPORT).toBe('resend');
    expect(() => parseEnv({ ...prod, MAIL_TRANSPORT: 'log' })).toThrow(/MAIL_TRANSPORT/);
  });

  it('createMailer picks the configured transport', () => {
    const memory = createMailer(parseEnv({ ...base, MAIL_TRANSPORT: 'memory' }), logger);
    expect(memory).toHaveProperty('outbox');
    const resend = createMailer(
      parseEnv({
        ...base,
        MAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_abcdefgh123',
        MAIL_FROM: 'a@yourapp.in',
      }),
      logger,
    );
    expect(resend).not.toHaveProperty('outbox');
  });
});
