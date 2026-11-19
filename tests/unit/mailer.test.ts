import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import { createLogger } from '../../src/lib/logger.js';
import {
  MailSendError,
  createMailer,
  memoryMailer,
  resendMailer,
  senderFor,
  withMailPolicy,
  type MailMessage,
  type ResendClient,
} from '../../src/lib/mailer.js';

// The real SDK is never constructed: every Resend instance in this file is this fake.
const sdk = vi.hoisted(() => ({
  instances: [] as { key: unknown; options: unknown; send: ReturnType<typeof vi.fn> }[],
}));
vi.mock('resend', () => ({
  Resend: class {
    emails: { send: ReturnType<typeof vi.fn> };
    constructor(key: unknown, options: unknown) {
      const send = vi.fn(async () => ({ data: { id: 'email_sdk' }, error: null, headers: null }));
      this.emails = { send };
      sdk.instances.push({ key, options, send });
    }
  },
}));

const logger = createLogger('silent');
const KEY = 're_secretkey_123456';
const LINK = 'https://powerhouse.yourapp.in/login/verify?token=secret';
const msg: MailMessage = {
  to: 'arjun@member.demo',
  subject: 'Your sign-in link',
  text: LINK,
  kind: 'magic_link',
};

type SendFn = ResendClient['emails']['send'];
const ok = (id = 'email_123') => ({ data: { id }, error: null, headers: null });
const apiError = (statusCode: number | null, name: string, message: string) => ({
  data: null,
  error: { statusCode, name, message },
  headers: null,
});
function fakeClient(impl: (...a: Parameters<SendFn>) => Promise<unknown>) {
  const send = vi.fn(impl);
  return { client: { emails: { send } } as unknown as ResendClient, send };
}
/** Everything written to the logger, for "never logs X" checks. */
function captureLogs() {
  const spies = (['info', 'warn', 'error'] as const).map((l) => vi.spyOn(logger, l));
  return () => JSON.stringify(spies.map((s) => s.mock.calls));
}

beforeEach(() => {
  vi.restoreAllMocks();
  sdk.instances.length = 0;
});

describe('resendMailer (mocked Resend client)', () => {
  it('sends one email with the sender, recipient and a kind tag, and logs only the id', async () => {
    const { client, send } = fakeClient(async () => ok());
    const logs = captureLogs();
    const result = await resendMailer({
      client,
      from: 'Fitexaa <no-reply@mail.fitexaa.com>',
      logger,
    }).send({ ...msg, fromName: 'Powerhouse Fitness' });

    expect(result).toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledOnce();
    const [payload, options] = send.mock.calls[0]!;
    expect(payload).toEqual({
      from: '"Powerhouse Fitness" <no-reply@mail.fitexaa.com>',
      to: ['arjun@member.demo'],
      subject: 'Your sign-in link',
      text: LINK,
      tags: [{ name: 'kind', value: 'magic_link' }],
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(logs()).toContain('email_123');
    expect(logs()).not.toContain('arjun@member.demo');
    expect(logs()).not.toContain('token=');
  });

  it('turns a Resend rejection into MailSendError without the recipient or link', async () => {
    const { client } = fakeClient(async () =>
      apiError(422, 'validation_error', 'Invalid `to` field: arjun@member.demo'),
    );
    const err = await resendMailer({ client, from: 'a@b.in', logger })
      .send(msg)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect(err).toMatchObject({ status: 422, providerCode: 'validation_error' });
    expect(String((err as Error).message)).not.toMatch(/arjun|token/);
  });

  it('reports network failure (returned or thrown) and timeouts as MailSendError', async () => {
    // The SDK returns network errors instead of throwing.
    const returned = fakeClient(async () =>
      apiError(null, 'application_error', 'Unable to fetch data.'),
    );
    await expect(
      resendMailer({ client: returned.client, from: 'a@b.in', logger }).send(msg),
    ).rejects.toThrow(/^Resend request failed$/);

    const thrown = fakeClient(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      resendMailer({ client: thrown.client, from: 'a@b.in', logger }).send(msg),
    ).rejects.toThrow(/^Resend request failed$/);

    // A slow API: the SDK sees our abort signal and returns an error, as it does for fetch aborts.
    const slow = fakeClient(
      (_p, o) =>
        new Promise((resolve) =>
          o!.signal!.addEventListener('abort', () =>
            resolve(apiError(null, 'application_error', 'Unable to fetch data.')),
          ),
        ),
    );
    await expect(
      resendMailer({ client: slow.client, from: 'a@b.in', logger, timeoutMs: 20 }).send(msg),
    ).rejects.toThrow(/timed out/);
  });
});

describe('withMailPolicy', () => {
  const policy = (allowed: string[] | null) => {
    const real = fakeClient(async () => ok());
    const divert = memoryMailer();
    const mailer = withMailPolicy(resendMailer({ client: real.client, from: 'a@b.in', logger }), {
      enabledKinds: new Set(['magic_link', 'password_reset', 'invite'] as const),
      allowedRecipients: allowed ? new Set(allowed) : null,
      divert,
      logger,
    });
    return { mailer, send: real.send, divert };
  };

  it('skips kinds that are not enabled and logs "skipped: kind not enabled", nothing personal', async () => {
    const { mailer, send, divert } = policy(null);
    const logs = captureLogs();
    const result = await mailer.send({ ...msg, kind: 'renewal_reminder' });
    expect(result).toEqual({ status: 'skipped', reason: 'kind_not_enabled' });
    expect(send).not.toHaveBeenCalled();
    expect(divert.outbox).toHaveLength(0);
    expect(logs()).toContain('Email skipped: kind not enabled');
    expect(logs()).toContain('renewal_reminder');
    expect(logs()).not.toContain('arjun@member.demo');
  });

  it('allow-list: listed addresses (any case) are sent, anyone else is logged instead', async () => {
    const { mailer, send, divert } = policy(['owner@realmail.in']);
    expect(await mailer.send({ ...msg, to: 'Owner@RealMail.in' })).toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledOnce();

    expect(await mailer.send(msg)).toEqual({
      status: 'skipped',
      reason: 'recipient_not_allowed',
    });
    expect(send).toHaveBeenCalledOnce();
    expect(divert.outbox.map((m) => m.to)).toEqual(['arjun@member.demo']);
  });

  it('an empty allow-list sends nothing; no allow-list (production) sends to anyone', async () => {
    const none = policy([]);
    await none.mailer.send(msg);
    expect(none.send).not.toHaveBeenCalled();

    const prod = policy(null);
    expect(await prod.mailer.send(msg)).toEqual({ status: 'sent' });
    expect(prod.send).toHaveBeenCalledOnce();
  });

  it('kind check comes first: a disabled kind is not even logged to an allowed address', async () => {
    const { mailer, send, divert } = policy(['arjun@member.demo']);
    expect(await mailer.send({ ...msg, kind: 'renewal_reminder' })).toMatchObject({
      reason: 'kind_not_enabled',
    });
    expect(send).not.toHaveBeenCalled();
    expect(divert.outbox).toHaveLength(0);
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
});

describe('mail config', () => {
  const base = {
    MONGODB_URI: 'mongodb://x/y',
    BASE_DOMAINS: 'yourapp.in',
    JWT_ACCESS_SECRET: 'x'.repeat(48),
  };
  const resend = {
    MAIL_TRANSPORT: 'resend',
    RESEND_API_KEY: KEY,
    MAIL_FROM: 'Fitexaa <no-reply@mail.fitexaa.com>',
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

  it('enabled kinds default to sign-in emails; unknown kinds are refused', () => {
    expect(parseEnv(base).MAIL_ENABLED_KINDS).toEqual(['magic_link', 'password_reset', 'invite']);
    expect(
      parseEnv({ ...base, MAIL_ENABLED_KINDS: 'magic_link, Renewal_Reminder' }).MAIL_ENABLED_KINDS,
    ).toEqual(['magic_link', 'renewal_reminder']);
    expect(() => parseEnv({ ...base, MAIL_ENABLED_KINDS: 'magic_link,receipts' })).toThrow(
      /MAIL_ENABLED_KINDS/,
    );
  });

  it('allow-list is parsed, lower-cased and validated', () => {
    expect(
      parseEnv({ ...base, MAIL_ALLOWED_RECIPIENTS: ' Me@Gmail.com , you@x.in ' })
        .MAIL_ALLOWED_RECIPIENTS,
    ).toEqual(['me@gmail.com', 'you@x.in']);
    expect(() => parseEnv({ ...base, MAIL_ALLOWED_RECIPIENTS: 'me@gmail.com,nope' })).toThrow(
      /MAIL_ALLOWED_RECIPIENTS/,
    );
  });

  it('production needs a real provider, sign-in emails enabled, and no allow-list', () => {
    expect(parseEnv({ ...prod, ...resend }).MAIL_TRANSPORT).toBe('resend');
    expect(() => parseEnv({ ...prod, MAIL_TRANSPORT: 'log' })).toThrow(/MAIL_TRANSPORT/);
    expect(() => parseEnv({ ...prod, MAIL_TRANSPORT: 'memory' })).toThrow(/MAIL_TRANSPORT/);
    expect(() => parseEnv({ ...prod, ...resend, MAIL_ALLOWED_RECIPIENTS: 'me@x.in' })).toThrow(
      /MAIL_ALLOWED_RECIPIENTS/,
    );
    expect(() => parseEnv({ ...prod, ...resend, MAIL_ENABLED_KINDS: 'invite' })).toThrow(
      /magic_link/,
    );
  });

  it('createMailer builds the SDK client with the key and the pinned API host', () => {
    expect(createMailer(parseEnv({ ...base, MAIL_TRANSPORT: 'memory' }), logger)).toHaveProperty(
      'outbox',
    );
    expect(sdk.instances).toHaveLength(0);
    createMailer(parseEnv({ ...base, ...resend }), logger);
    expect(sdk.instances).toHaveLength(1);
    expect(sdk.instances[0]).toMatchObject({
      key: KEY,
      options: { baseUrl: 'https://api.resend.com' },
    });
  });

  it('development: only allow-listed recipients reach Resend; the key is never logged', async () => {
    const logs = captureLogs();
    const mailer = createMailer(
      parseEnv({ ...base, ...resend, MAIL_ALLOWED_RECIPIENTS: 'owner@realmail.in' }),
      logger,
    );
    const { send } = sdk.instances[0]!;

    expect(await mailer.send(msg)).toMatchObject({ reason: 'recipient_not_allowed' });
    expect(
      await mailer.send({ ...msg, kind: 'renewal_reminder', to: 'owner@realmail.in' }),
    ).toMatchObject({ reason: 'kind_not_enabled' });
    expect(send).not.toHaveBeenCalled();

    expect(await mailer.send({ ...msg, to: 'owner@realmail.in' })).toEqual({ status: 'sent' });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ to: ['owner@realmail.in'] });
    expect(logs()).not.toContain(KEY);
  });

  it('production: no allow-list, so any recipient is sent (enabled kinds only)', async () => {
    const mailer = createMailer(parseEnv({ ...prod, ...resend }), logger);
    const { send } = sdk.instances[0]!;
    expect(await mailer.send(msg)).toEqual({ status: 'sent' });
    expect(await mailer.send({ ...msg, kind: 'renewal_reminder' })).toMatchObject({
      reason: 'kind_not_enabled',
    });
    expect(send).toHaveBeenCalledOnce();
  });
});
