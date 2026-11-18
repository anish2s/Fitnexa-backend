import type { Env } from '../config/env.js';
import type { Logger } from './logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Tag for tests/observability, e.g. 'magic_link'. Never contains secrets. */
  kind: string;
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

/**
 * Email delivery interface. `send` throws when the provider refuses or can't be reached; callers
 * decide whether that fails the request (see safeSend in auth.service.ts).
 *
 * Transports: `log` (dev), `memory` (tests), `resend` (real delivery; owner's choice 2026-11-17).
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Development: prints the email (including the link) to the log so you can click it locally. */
export function logMailer(logger: Logger): Mailer {
  return {
    async send(m) {
      logger.info(
        { mail: { to: m.to, from: m.fromName ?? null, subject: m.subject, kind: m.kind } },
        `EMAIL (dev, not sent)\n${m.text}`,
      );
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

export interface ResendOptions {
  apiKey: string;
  from: string;
  logger: Logger;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Override for tests only. */
  endpoint?: string;
}

/**
 * Resend (https://resend.com) over its REST API, so no SDK dependency.
 *
 * Free plan: 100 emails/day, 3,000/month, and sending only from a domain verified in Resend.
 * Sign-in links and invites are the only mail today, so that is plenty for a pilot. No retries
 * here: every caller is a user action the user can repeat, and a retry loop could double-send a
 * one-time link.
 */
export function resendMailer(opts: ResendOptions): Mailer {
  const doFetch = opts.fetch ?? fetch;
  const endpoint = opts.endpoint ?? 'https://api.resend.com/emails';
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    async send(m) {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: senderFor(opts.from, m.fromName),
            to: [m.to],
            subject: m.subject,
            text: m.text,
            tags: [{ name: 'kind', value: m.kind }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed';
        throw new MailSendError(`Resend request ${reason}`);
      }

      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        name?: string;
        message?: string;
      };
      if (!res.ok) {
        // Resend's error message can quote the recipient; log only status and error name.
        throw new MailSendError(`Resend rejected the email (${res.status})`, res.status, body.name);
      }
      opts.logger.info({ mail: { kind: m.kind, providerId: body.id } }, 'Email sent');
    },
  };
}

/** Picks the transport from config. Production config refuses log/memory (see env.ts). */
export function createMailer(env: Env, logger: Logger): Mailer {
  switch (env.MAIL_TRANSPORT) {
    case 'resend':
      return resendMailer({ apiKey: env.RESEND_API_KEY!, from: env.MAIL_FROM, logger });
    case 'memory':
      return memoryMailer();
    default:
      return logMailer(logger);
  }
}
