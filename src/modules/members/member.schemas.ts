import { z } from 'zod';
import { parseDateOnly } from '../../lib/dates.js';
import { objectId, pageQuery } from '../../lib/pagination.js';
import { emailField, phoneField } from '../tenants/tenant.schemas.js';
import { GENDERS } from './member.model.js';

export const MEMBER_LIST_STATUSES = ['active', 'expiring', 'upcoming', 'expired', 'none'] as const;

/** `YYYY-MM-DD` → Date at UTC midnight. */
const dateOnly = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const d = parseDateOnly(v);
    if (!d) {
      ctx.addIssue({ code: 'custom', message: 'Use a date like 2026-04-01' });
      return z.NEVER;
    }
    return d;
  });

const DAY = 86_400_000;
const dateOfBirth = dateOnly.refine(
  (d) => d.getTime() >= Date.UTC(1900, 0, 1) && d.getTime() <= Date.now() - 3 * 365 * DAY,
  'Enter a real date of birth',
);
/** Back-dating is common when entering existing members; far-future dates are typos. */
const joinDate = dateOnly.refine(
  (d) => d.getTime() >= Date.UTC(1990, 0, 1) && d.getTime() <= Date.now() + 31 * DAY,
  'Join date must be within the next month',
);

const emergencyContact = z.object({
  name: z.string().trim().min(1).max(120),
  phone: phoneField,
  relation: z.string().trim().min(1).max(40).optional(),
});

const name = z.string().trim().min(1).max(120);
const notes = z.string().trim().max(1000);

export const memberIdParams = z.object({ id: objectId });

export const memberListQuery = pageQuery.extend({
  /** Name, phone digits, email or member code. */
  q: z.string().trim().min(1).max(100).optional(),
  archived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
  sort: z.enum(['-joinDate', 'joinDate', 'name', 'memberCode']).default('-joinDate'),
  joinedFrom: dateOnly.optional(),
  joinedTo: dateOnly.optional(),
  /**
   * Current membership status, as on the member profile. `expiring` = active, ending within the
   * gym's renewal reminder window and not yet renewed (same rule as /memberships/expiring).
   */
  status: z.enum(MEMBER_LIST_STATUSES).optional(),
  /** Only members who still owe money on a non-cancelled membership. */
  due: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const createMemberBody = z.object({
  name,
  phone: phoneField,
  /** Optional, but without it the member can't use the member app (sign-in is by email link). */
  email: emailField.optional(),
  gender: z.enum(GENDERS).optional(),
  dateOfBirth: dateOfBirth.optional(),
  /** Defaults to today in the gym's time zone. */
  joinDate: joinDate.optional(),
  emergencyContact: emergencyContact.optional(),
  notes: notes.optional(),
  /** DPDP: the front desk confirms the member agreed to the gym storing their details. */
  consent: z.literal(true, { message: "Record the member's consent before saving" }),
});

/** `null` clears an optional field. */
export const updateMemberBody = z
  .object({
    name: name.optional(),
    phone: phoneField.optional(),
    email: emailField.nullable().optional(),
    gender: z.enum(GENDERS).nullable().optional(),
    dateOfBirth: dateOfBirth.nullable().optional(),
    joinDate: joinDate.optional(),
    emergencyContact: emergencyContact.nullable().optional(),
    notes: notes.nullable().optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), 'Nothing to update');

/** What a member may change about themselves in the app. */
export const selfUpdateBody = z
  .object({
    gender: z.enum(GENDERS).nullable().optional(),
    dateOfBirth: dateOfBirth.nullable().optional(),
    emergencyContact: emergencyContact.nullable().optional(),
    /** Visits per month the member aims for (1–31); null clears it. */
    monthlyVisitGoal: z.number().int().min(1).max(31).nullable().optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), 'Nothing to update');

export type MemberListQuery = z.infer<typeof memberListQuery>;
export type CreateMemberInput = z.infer<typeof createMemberBody>;
export type UpdateMemberInput = z.infer<typeof updateMemberBody>;
export type SelfUpdateInput = z.infer<typeof selfUpdateBody>;

export const importQuery = z.object({
  dryRun: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(true),
  consentConfirmed: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
});
