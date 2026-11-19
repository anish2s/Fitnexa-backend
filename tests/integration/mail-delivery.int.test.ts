import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/lib/logger.js';
import {
  memoryMailer,
  resendMailer,
  withMailPolicy,
  type ResendClient,
} from '../../src/lib/mailer.js';
import { mongoTenantLookup } from '../../src/modules/tenants/tenant.lookup.js';
import { buildTestApp } from '../helpers/app.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { PASSWORD, PH, PLATFORM, resetDemo } from '../helpers/int.js';

/**
 * The real Resend transport + send policy behind the HTTP API, with a mocked Resend client.
 * Proves that provider trouble or a policy skip never changes what a sign-in requester sees, and
 * that nothing personal or secret reaches the logs.
 */
type Mode = 'ok' | 'reject' | 'down' | 'timeout';
let mode: Mode = 'ok';
const send = vi.fn<ResendClient['emails']['send']>(async (_payload, options) => {
  if (mode === 'reject') {
    return {
      data: null,
      error: { statusCode: 403, name: 'validation_error', message: 'arjun@member.demo blocked' },
      headers: null,
    };
  }
  if (mode === 'down') throw new TypeError('fetch failed');
  if (mode === 'timeout') {
    await new Promise((r) => options!.signal!.addEventListener('abort', r));
    return {
      data: null,
      error: { statusCode: null, name: 'application_error', message: 'Unable to fetch data.' },
      headers: null,
    };
  }
  return { data: { id: 'email_1' }, error: null, headers: null };
});

const logger = createLogger('silent');
const diverted = memoryMailer();
const ALLOWED = [
  'arjun@member.demo',
  'owner@powerhouse.demo',
  'newowner@realmail.in',
  'failowner@realmail.in',
  'tester+*@realmail.in',
];
const mailer = withMailPolicy(
  resendMailer({
    client: { emails: { send } } as ResendClient,
    from: 'Fitexaa <no-reply@mail.fitexaa.com>',
    logger,
    timeoutMs: 30,
  }),
  {
    enabledKinds: new Set(['magic_link', 'password_reset', 'invite'] as const),
    allowedRecipients: new Set(ALLOWED),
    divert: diverted,
    logger,
  },
);
const app = buildTestApp({
  lookup: mongoTenantLookup,
  mailer,
  logger,
  env: { AUTH_RATE_LIMIT_MAX: '1000', RATE_LIMIT_MAX: '100000' },
}) as Express;

const post = (host: string, path: string, body: object, token?: string) => {
  const r = request(app).post(`/api/v1${path}`).set('Host', host);
  return (token ? r.set('Authorization', `Bearer ${token}`) : r).send(body);
};
const magicLink = (email: string) => post(PH, '/auth/magic-link', { email });
const forgot = (email: string) => post(PH, '/auth/password/forgot', { email });

function captureLogs() {
  const spies = (['info', 'warn', 'error'] as const).map((l) => vi.spyOn(logger, l));
  // The per-request access log is left out: the spy sees its raw req/res objects, which pino's
  // serializers reduce to method, URL and headers before anything is written. Logged errors can be
  // circular; keep every own field (and the message) of each object once.
  const appCalls = () =>
    spies
      .flatMap((s) => s.mock.calls)
      .filter((c) => !(c[0] && typeof c[0] === 'object' && 'res' in c[0]));
  return () => {
    const seen = new WeakSet<object>();
    return JSON.stringify(appCalls(), (_k, v: unknown) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
        if (v instanceof Error) return { ...v, name: v.name, message: v.message };
      }
      return v;
    });
  };
}

describeWithDb('email delivery through Resend (mocked client, real MongoDB)', () => {
  beforeAll(async () => {
    await connectTestDb(`mail_delivery_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(memoryMailer());
    vi.restoreAllMocks();
    send.mockClear();
    diverted.clear();
    mode = 'ok';
  });

  it('sends a sign-in link to an allowed address under the gym name', async () => {
    const res = await magicLink('arjun@member.demo');
    expect(res.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({
      from: '"Powerhouse Fitness" <no-reply@mail.fitexaa.com>',
      to: ['arjun@member.demo'],
      tags: [{ name: 'kind', value: 'magic_link' }],
    });
  });

  it('Resend rejecting, down or timing out: same 202 as an unknown email, logged without the link', async () => {
    const unknown = await magicLink('nobody@nowhere.in');
    for (const m of ['reject', 'down', 'timeout'] as const) {
      mode = m;
      const logs = captureLogs();
      const res = await magicLink('arjun@member.demo');
      expect(res.status, m).toBe(202);
      expect(res.body, m).toEqual(unknown.body);

      const resetRes = await forgot('owner@powerhouse.demo');
      expect(resetRes.status, m).toBe(202);

      const logged = logs();
      expect(logged, m).toContain('Email could not be sent');
      expect(logged, m).toContain(m === 'timeout' ? 'timed out' : 'Resend');
      expect(logged, m).not.toMatch(/token=|verify\?|reset-password/);
      expect(logged, m).not.toContain('arjun@member.demo');
      expect(logged, m).not.toContain('owner@powerhouse.demo');
      vi.restoreAllMocks();
    }
    expect(send).toHaveBeenCalledTimes(6);
  });

  it('a seed address outside the allow-list is logged, not sent, and the answer is the same', async () => {
    const res = await magicLink('priya@member.demo');
    expect(res.status).toBe(202);
    expect(send).not.toHaveBeenCalled();
    expect(diverted.outbox.map((m) => [m.to, m.kind])).toEqual([
      ['priya@member.demo', 'magic_link'],
    ]);
  });

  it('a gym-creation invite reports the real outcome to the super admin', async () => {
    const admin = await post(PLATFORM, '/auth/login', {
      identifier: 'admin@platform.demo',
      password: PASSWORD,
    });
    expect(admin.status).toBe(200);
    const token = admin.body.data.accessToken as string;
    const create = (slug: string, email: string) =>
      post(
        PLATFORM,
        '/platform/tenants',
        { name: `Gym ${slug}`, slug, owner: { name: 'New Owner', email } },
        token,
      );

    const allowed = await create('allowedgym', 'newowner@realmail.in');
    expect(allowed.status).toBe(201);
    expect(allowed.body.data).toMatchObject({ inviteSent: true, inviteError: null });

    const plus = await create('plusgym', 'Tester+plusgym@realmail.in');
    expect(plus.status).toBe(201);
    expect(plus.body.data).toMatchObject({ inviteSent: true, inviteError: null });
    expect(send.mock.calls.at(-1)![0]).toMatchObject({ to: ['tester+plusgym@realmail.in'] });

    const blocked = await create('blockedgym', 'someone@member.demo');
    expect(blocked.status).toBe(201);
    expect(blocked.body.data).toMatchObject({
      inviteSent: false,
      inviteError: 'recipient_not_allowed',
    });

    mode = 'down';
    const failed = await create('failedgym', 'failowner@realmail.in');
    expect(failed.status).toBe(201);
    expect(failed.body.data).toMatchObject({ inviteSent: false, inviteError: 'send_failed' });
  });
});
