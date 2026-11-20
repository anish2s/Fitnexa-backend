import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resend } from 'resend';
import type { Env } from '../config/env.js';
import type { Logger } from './logger.js';
import type { MailKind } from './mail-kinds.js';
import { recipientMatcher } from './mail-recipients.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** What the email is for; decides whether it may be sent (MAIL_ENABLED_KINDS). No secrets. */
  kind: MailKind;
  /**
   * Sender display name. Gym mail passes the gym's name so members only ever see their gym's
   * brand; the address always comes from MAIL_FROM (the verified sending domain).
   */
  fromName?: string;
}

/**
 * `"Name" <address>` with the address from MAIL_FROM. Gym names are typed by owners and land in a
 * mail header, so control characters (header injection) and characters that would break the
 * quoting or the address part are removed. Falls back to MAIL_FROM unchanged.
 */
export function senderFor(mailFrom: string, fromName?: string): string {
  const name = (fromName ?? '')
    .replace(/[\p{Cc}"\\<>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim();
  if (!name) return mailFrom;
  const address = /<([^<>]+)>\s*$/.exec(mailFrom)?.[1]?.trim() ?? mailFrom.trim();
  return `"${name}" <${address}>`;
}

/** Why a message was deliberately not delivered. Not an error: nothing went wrong. */
export type SkipReason = 'kind_not_enabled' | 'recipient_not_allowed';
export type SendResult = { status: 'sent' } | { status: 'skipped'; reason: SkipReason };
const SENT: SendResult = { status: 'sent' };

/**
 * Email delivery interface. `send` resolves `sent`, or `skipped` when config says this email must
 * not go out; it throws MailSendError when the provider refuses or can't be reached. Callers decide
 * whether a failure fails the request (see safeSend in auth.service.ts).
 *
 * Transports: `log` (dev), `memory` (tests), `file` (dev/e2e: JSON lines), `resend` (real delivery;
 * owner's choice 2026-11-17).
 */
export interface Mailer {
  send(message: MailMessage): Promise<SendResult>;
}

/** Development: prints the email (including the link) to the log so you can click it locally. */
export function logMailer(logger: Logger): Mailer {
  return {
    async send(m) {
      logger.info(
        { mail: { to: m.to, from: m.fromName ?? null, subject: m.subject, kind: m.kind } },
        `EMAIL (dev, not sent)\n${m.text}`,
      );
      return SENT;
    },
  };
}

/** Tests: keeps messages in memory. */
export function memoryMailer() {
  const outbox: MailMessage[] = [];
  const mailer: Mailer & { outbox: MailMessage[]; clear(): void } = {
    outbox,
    async send(m) {
      outbox.push(m);
      return SENT;
    },
    clear() {
      outbox.length = 0;
    },
  };
  return mailer;
}

/** Raised by real transports. Carries no recipient or message content (both may be personal). */
export class MailSendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'MailSendError';
  }
}

/** The one SDK call we use, so tests can pass a fake client. */
export interface ResendClient {
  emails: Pick<Resend['emails'], 'send'>;
}

export interface ResendOptions {
  client: ResendClient;
  from: string;
  logger: Logger;
  timeoutMs?: number;
}

/**
 * Resend (https://resend.com) through its official Node SDK.
 *
 * Free plan: 100 emails/day, 3,000/month, and sending only from a domain verified in Resend. No
 * retries here: every caller is a user action the user can repeat (or the reminder queue, which
 * has its own backoff), and a retry loop could double-send a one-time link.
 *
 * The SDK reports API and network errors as `{ error }` rather than throwing; both, and anything
 * thrown, become MailSendError. Resend's error `message` can quote the recipient, so only its
 * `name` and status code are kept.
 */
export function resendMailer(opts: ResendOptions): Mailer {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    async send(m) {
      const signal = AbortSignal.timeout(timeoutMs);
      let res: Awaited<ReturnType<ResendClient['emails']['send']>>;
      try {
        res = await opts.client.emails.send(
          {
            from: senderFor(opts.from, m.fromName),
            to: [m.to],
            subject: m.subject,
            text: m.text,
            tags: [{ name: 'kind', value: m.kind }],
          },
          { signal },
        );
      } catch {
        throw new MailSendError(`Resend request ${signal.aborted ? 'timed out' : 'failed'}`);
      }
      if (res.error) {
        if (signal.aborted) throw new MailSendError('Resend request timed out');
        const status = res.error.statusCode ?? undefined;
        throw new MailSendError(
          status ? `Resend rejected the email (${status})` : 'Resend request failed',
          status,
          res.error.name,
        );
      }
      opts.logger.info({ mail: { kind: m.kind, providerId: res.data?.id } }, 'Email sent');
      return SENT;
    },
  };
}

export interface MailPolicy {
  enabledKinds: ReadonlySet<MailKind>;
  /**
   * Addresses (or `name+*@domain` patterns, see mail-recipients.ts) real mail may go to;
   * null = anyone (production).
   */
  allowedRecipients: Iterable<string> | null;
  /** Where mail for other recipients goes instead (the log transport). */
  divert: Mailer;
  logger: Logger;
}

/**
 * Decides what a real transport may send. Kinds not enabled are dropped. Outside production, mail
 * to anyone not on the allow-list is diverted to the log: the seed uses fake addresses
 * (@member.demo) and bounces would hurt the sending domain's reputation. Neither log line carries
 * the recipient or content, except the diverted copy, which only happens outside production.
 */
export function withMailPolicy(inner: Mailer, policy: MailPolicy): Mailer {
  const allowed = policy.allowedRecipients ? recipientMatcher(policy.allowedRecipients) : null;
  return {
    async send(m) {
      if (!policy.enabledKinds.has(m.kind)) {
        policy.logger.info({ mail: { kind: m.kind } }, 'Email skipped: kind not enabled');
        return { status: 'skipped', reason: 'kind_not_enabled' };
      }
      if (allowed && !allowed(m.to)) {
        policy.logger.info(
          { mail: { kind: m.kind } },
          'Email not sent: recipient not in MAIL_ALLOWED_RECIPIENTS; logged instead',
        );
        await policy.divert.send(m);
        return { status: 'skipped', reason: 'recipient_not_allowed' };
      }
      return inner.send(m);
    },
  };
}

/** The backend folder (src/lib/ or dist/lib/ → two levels up): relative MAIL_FILE paths start here. */
const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Development/e2e: appends each email as one JSON line `{ at, kind, to, subject, text }`, so an
 * automated test can read the sign-in link. Production config refuses it (see env.ts).
 */
export function fileMailer(path: string, now: () => Date = () => new Date()): Mailer {
  const file = isAbsolute(path) ? path : resolve(BACKEND_ROOT, path);
  let ready: Promise<unknown> | null = null;
  return {
    async send(m) {
      ready ??= mkdir(dirname(file), { recursive: true });
      await ready;
      const line = {
        at: now().toISOString(),
        kind: m.kind,
        to: m.to,
        subject: m.subject,
        text: m.text,
      };
      await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8');
      return SENT;
    },
  };
}

/** The official API host, pinned: the SDK would otherwise honour a RESEND_BASE_URL env var. */
const RESEND_API = 'https://api.resend.com';

/** Picks the transport from config. Production config refuses log/memory (see env.ts). */
export function createMailer(env: Env, logger: Logger): Mailer {
  switch (env.MAIL_TRANSPORT) {
    case 'resend':
      return withMailPolicy(
        resendMailer({
          client: new Resend(env.RESEND_API_KEY, { baseUrl: RESEND_API }),
          from: env.MAIL_FROM,
          logger,
        }),
        {
          enabledKinds: new Set(env.MAIL_ENABLED_KINDS),
          allowedRecipients: env.NODE_ENV === 'production' ? null : env.MAIL_ALLOWED_RECIPIENTS,
          divert: logMailer(logger),
          logger,
        },
      );
    case 'memory':
      return memoryMailer();
    case 'file':
      return fileMailer(env.MAIL_FILE);
    default:
      return logMailer(logger);
  }
}
