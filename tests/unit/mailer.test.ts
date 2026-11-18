import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import { createLogger } from '../../src/lib/logger.js';
import {
  MailSendError,
  createMailer,
  resendMailer,
  senderFor,
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

describe('senderFor (gym name as the sender)', () => {
  const FROM = 'Fitexaa <no-reply@mail.yourapp.in>';

  it("keeps MAIL_FROM's address and shows the gym's name", () => {
    expect(senderFor(FROM, 'Powerhouse Fitness')).toBe(
      '"Powerhouse Fitness" <no-reply@mail.yourapp.in>',
    );
    expect(senderFor('no-reply@mail.yourapp.in', 'FitZone')).toBe(
      '"FitZone" <no-reply@mail.yourapp.in>',
    );
  });

  it('falls back to MAIL_FROM with no or an empty name', () => {
    expect(senderFor(FROM)).toBe(FROM);
    expect(senderFor(FROM, '  \r\n "<>" ')).toBe(FROM);
  });

  it('cannot inject headers, break the quoting or swap the address', () => {
    const s = senderFor(FROM, 'Evil Gym\r\nBcc: victim@x.in');
    expect(s).toBe('"Evil Gym Bcc: victim@x.in" <no-reply@mail.yourapp.in>');
    expect(s).not.toMatch(/[\r\n]/);
    expect(senderFor(FROM, 'Gym" <attacker@evil.in>')).toBe(
      '"Gym attacker@evil.in" <no-reply@mail.yourapp.in>',
    );
    expect(senderFor(FROM, 'Back\\slash')).toBe('"Back slash" <no-reply@mail.yourapp.in>');
    expect(senderFor(FROM, 'x'.repeat(200))).toBe(`"${'x'.repeat(64)}" <no-reply@mail.yourapp.in>`);
  });

  it('the Resend transport sends gym mail under the gym name', async () => {
    const f = fakeFetch(200, { id: 'email_1' });
    await resendMailer({ apiKey: 're_k', from: FROM, logger, fetch: f }).send({
      ...msg,
      fromName: 'Powerhouse Fitness',
    });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).from).toBe(
      '"Powerhouse Fitness" <no-reply@mail.yourapp.in>',
    );
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
      MAIL_FROM: 'Fitexaa <no-reply@yourapp.in>',
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
