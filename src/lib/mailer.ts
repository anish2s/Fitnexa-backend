import type { Logger } from './logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Tag for tests/observability, e.g. 'magic_link'. Never contains secrets. */
  kind: string;
}

/**
 * Email delivery interface. Real providers (Resend / SES / SMTP) plug in here in Milestone 9.
 * Until then nothing leaves the machine: project Rule 8 forbids sending real notifications
 * without approval, and config validation refuses to start production without a real provider.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Development: prints the email (including the link) to the log so you can click it locally. */
export function logMailer(logger: Logger): Mailer {
  return {
    async send(m) {
      logger.info(
        { mail: { to: m.to, subject: m.subject, kind: m.kind } },
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
