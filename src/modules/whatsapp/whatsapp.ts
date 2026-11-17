/**
 * WhatsApp click-to-chat links (https://wa.me/<number>?text=...). The desk opens the link and sends
 * from the gym's own WhatsApp: nothing is sent by the server, no WhatsApp Business API, no cost.
 */
export const TEMPLATES = ['renewal', 'payment_due', 'welcome', 'custom'] as const;
export type Template = (typeof TEMPLATES)[number];

/** wa.me wants the full international number, digits only (no +, spaces or leading zeros). */
export function waLink(phoneE164: string, text: string): string {
  const digits = phoneE164.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** ₹1,500 or ₹1,271.19: no ".00" for whole rupees (reads naturally in a chat). */
export function rupees(paise: number): string {
  const whole = paise % 100 === 0;
  return (
    '₹' +
    (paise / 100).toLocaleString('en-IN', {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    })
  );
}

export const prettyDate = (dateOnly: string) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${dateOnly}T00:00:00Z`));

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

export interface MessageContext {
  gymName: string;
  appUrl: string;
  memberName: string;
  memberCode: string;
  membership?: { plan: string; endDate: string; ended: boolean; balancePaise: number } | null;
}

/** Message text for a template; null when it doesn't apply (e.g. nothing is due). */
export function messageFor(t: Exclude<Template, 'custom'>, c: MessageContext): string | null {
  const hi = `Hi ${firstName(c.memberName)},`;
  const m = c.membership;
  switch (t) {
    case 'renewal':
      if (!m) return null;
      return m.ended
        ? `${hi} your ${m.plan} membership at ${c.gymName} ended on ${prettyDate(m.endDate)}. We'd love to see you back! Renew at the front desk or in the app: ${c.appUrl}`
        : `${hi} your ${m.plan} membership at ${c.gymName} ends on ${prettyDate(m.endDate)}. Renew at the front desk or in the app so your workouts don't stop: ${c.appUrl}`;
    case 'payment_due':
      if (!m || m.balancePaise <= 0) return null;
      return `${hi} a balance of ${rupees(m.balancePaise)} is due on your ${m.plan} membership at ${c.gymName}. You can pay at the front desk or in the app: ${c.appUrl}`;
    case 'welcome':
      return `Welcome to ${c.gymName}, ${firstName(c.memberName)}! Your member code is ${c.memberCode}. Open the member app to see your plan and check-in pass: ${c.appUrl}`;
  }
}
