/**
 * Normalise a phone number to E.164. Front-desk input is messy ("98765 43210", "+91-98765-43210",
 * "09876543210"); a 10-digit Indian mobile defaults to +91. Returns null if it can't be a phone.
 */
export function normalizePhone(input: string, defaultCountryCode = '91'): string | null {
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return null;
  if (!hasPlus) {
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10) digits = defaultCountryCode + digits;
  }
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}
