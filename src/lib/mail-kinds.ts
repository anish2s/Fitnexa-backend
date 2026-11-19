/**
 * Every kind of email the API can send. Config (MAIL_ENABLED_KINDS) is checked against this list,
 * and MailMessage.kind is typed by it, so a new email can't ship without being registered here.
 * Kept free of imports so config/env.ts can use it without loading the mail transports.
 */
export const MAIL_KINDS = ['magic_link', 'password_reset', 'invite', 'renewal_reminder'] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

/** Sign-in and account emails only (owner's decision, 2026-11-19). */
export const DEFAULT_ENABLED_MAIL_KINDS: readonly MailKind[] = [
  'magic_link',
  'password_reset',
  'invite',
];
