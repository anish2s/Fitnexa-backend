/**
 * Development allow-list entries (MAIL_ALLOWED_RECIPIENTS): exact addresses, or a plus-address
 * pattern `name+*@domain` that matches every `name+<tag>@domain`, so one inbox can receive mail
 * for many test owners and members (Gmail delivers `name+tag@gmail.com` to `name@gmail.com`).
 *
 * The wildcard is deliberately allowed only there: `*@gmail.com` or `name*@x` would let a typo
 * open real sending to strangers. Kept free of imports so config/env.ts can use it.
 */
const PLUS_PATTERN = /^([^\s@*+]+)\+\*@([^\s@*]+)$/;

/** True for a well-formed `name+*@domain` entry (the domain is checked as part of an address). */
export function isPlusPattern(entry: string): boolean {
  return PLUS_PATTERN.test(entry);
}

/** The pattern with the wildcard filled in, so it can be validated like any address. */
export function plusPatternExample(entry: string): string {
  return entry.replace('+*@', '+x@');
}

/** Builds the "may real mail go here?" check. Entries are compared case-insensitively. */
export function recipientMatcher(entries: Iterable<string>): (address: string) => boolean {
  const exact = new Set<string>();
  const plus: { local: string; domain: string }[] = [];
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    const m = PLUS_PATTERN.exec(entry);
    if (m) plus.push({ local: m[1]!, domain: m[2]! });
    else exact.add(entry);
  }
  return (address) => {
    const a = address.trim().toLowerCase();
    if (exact.has(a)) return true;
    const at = a.lastIndexOf('@');
    if (at < 0) return false;
    const local = a.slice(0, at);
    const domain = a.slice(at + 1);
    return plus.some(
      (p) =>
        p.domain === domain && local.startsWith(`${p.local}+`) && local.length > p.local.length + 1,
    );
  };
}
