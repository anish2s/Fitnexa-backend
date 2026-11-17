import mongoose, { Types } from 'mongoose';
import { parseCsv } from '../../lib/csv.js';
import { Errors } from '../../lib/errors.js';
import { parseDateOnly, todayIn } from '../../lib/dates.js';
import { requireTenantId } from '../../tenancy/context.js';
import type { AuditContext, AuditService } from '../audit/audit.service.js';
import { Counter } from '../counters/counter.model.js';
import { Tenant } from '../tenants/tenant.model.js';
import { User } from '../users/user.model.js';
import { MEMBER_CONSENT_VERSION, Member } from './member.model.js';
import { createMemberBody, type CreateMemberInput } from './member.schemas.js';
import { formatMemberCode } from './member.service.js';

export const MAX_IMPORT_ROWS = 2000;
const MAX_REPORTED_ERRORS = 500;

/** Spreadsheet header → field. Lower-cased, spaces/dashes → underscores before lookup. */
const HEADERS: Record<string, string> = {
  name: 'name',
  full_name: 'name',
  member_name: 'name',
  phone: 'phone',
  mobile: 'phone',
  phone_number: 'phone',
  mobile_number: 'phone',
  email: 'email',
  email_address: 'email',
  gender: 'gender',
  date_of_birth: 'dateOfBirth',
  dob: 'dateOfBirth',
  birth_date: 'dateOfBirth',
  join_date: 'joinDate',
  joining_date: 'joinDate',
  date_joined: 'joinDate',
  emergency_contact_name: 'ecName',
  emergency_contact_phone: 'ecPhone',
  emergency_contact_relation: 'ecRelation',
  notes: 'notes',
};
const FIELD_LABEL: Record<string, string> = {
  dateOfBirth: 'date_of_birth',
  joinDate: 'join_date',
  emergencyContact: 'emergency_contact',
};

export interface ImportError {
  /** Line number in the file (header is line 1), as a spreadsheet shows it. */
  row: number;
  field: string | null;
  message: string;
}

/** Indian spreadsheets usually hold DD/MM/YYYY; normalise to YYYY-MM-DD before validation. */
function normaliseDate(v: string): string {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v.trim());
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : v.trim();
}

export function createMemberImporter(deps: { audit: AuditService }) {
  const { audit } = deps;

  function parse(csv: string) {
    const rows = parseCsv(csv);
    if (rows.length < 2) throw Errors.badRequest('The file has no member rows');
    if (rows.length - 1 > MAX_IMPORT_ROWS) {
      throw Errors.badRequest(`At most ${MAX_IMPORT_ROWS} members per file`);
    }
    const header = rows[0]!.map(
      (h) =>
        HEADERS[
          h
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, '_')
        ],
    );
    const missing = ['name', 'phone'].filter((f) => !header.includes(f));
    if (missing.length) {
      throw Errors.badRequest(`Missing required column(s): ${missing.join(', ')}`, {
        recognised: Object.keys(HEADERS),
      });
    }
    return rows.slice(1).map((cells, i) => {
      const raw: Record<string, string> = {};
      header.forEach((field, c) => {
        const v = (cells[c] ?? '').trim();
        if (field && v) raw[field] = v;
      });
      return { line: i + 2, raw };
    });
  }

  function toInput(raw: Record<string, string>) {
    const ec =
      raw.ecName || raw.ecPhone
        ? { name: raw.ecName, phone: raw.ecPhone, relation: raw.ecRelation }
        : undefined;
    return {
      name: raw.name,
      phone: raw.phone,
      email: raw.email,
      gender: raw.gender?.toLowerCase(),
      dateOfBirth: raw.dateOfBirth && normaliseDate(raw.dateOfBirth),
      joinDate: raw.joinDate && normaliseDate(raw.joinDate),
      emergencyContact: ec,
      notes: raw.notes,
      consent: true,
    };
  }

  /**
   * Validates every row (shape, duplicates inside the file, clashes with this gym's members and
   * logins) and, unless dryRun, creates them all in one transaction. Any error → nothing is written.
   */
  async function run(
    csv: string,
    opts: { dryRun: boolean; consentConfirmed: boolean },
    ctx: AuditContext,
  ) {
    const rows = parse(csv);
    const errors: ImportError[] = [];
    const valid: { line: number; input: CreateMemberInput }[] = [];

    for (const { line, raw } of rows) {
      const parsed = createMemberBody.safeParse(toInput(raw));
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0] ?? '');
          errors.push({
            row: line,
            field: FIELD_LABEL[key] ?? (key || null),
            message: issue.message,
          });
        }
      } else valid.push({ line, input: parsed.data });
    }

    // Duplicates inside the file, then against what the gym already has.
    const firstSeen = new Map<string, number>();
    for (const { line, input } of valid) {
      for (const [field, value] of [
        ['phone', input.phone],
        ['email', input.email],
      ] as const) {
        if (!value) continue;
        const key = `${field}:${value}`;
        const first = firstSeen.get(key);
        if (first) errors.push({ row: line, field, message: `Same ${field} as row ${first}` });
        else firstSeen.set(key, line);
      }
    }
    const phones = valid.map((v) => v.input.phone);
    const emails = valid.flatMap((v) => (v.input.email ? [v.input.email] : []));
    const [phoneHits, memberEmailHits, userEmailHits] = await Promise.all([
      Member.find({ phone: { $in: phones } }).distinct('phone'),
      Member.find({ email: { $in: emails } }).distinct('email'),
      User.find({ email: { $in: emails } }).distinct('email'),
    ]);
    const takenPhone = new Set<string>(phoneHits as string[]);
    const takenEmail = new Set<string>([
      ...(memberEmailHits as string[]),
      ...(userEmailHits as string[]),
    ]);
    for (const { line, input } of valid) {
      if (takenPhone.has(input.phone)) {
        errors.push({
          row: line,
          field: 'phone',
          message: 'A member with this phone already exists',
        });
      }
      if (input.email && takenEmail.has(input.email)) {
        errors.push({
          row: line,
          field: 'email',
          message: 'This email is already used in this gym',
        });
      }
    }
    errors.sort((a, b) => a.row - b.row);

    const report = {
      dryRun: opts.dryRun,
      total: rows.length,
      valid: rows.length - new Set(errors.map((e) => e.row)).size,
      errorCount: errors.length,
      errors: errors.slice(0, MAX_REPORTED_ERRORS),
      created: 0,
    };
    if (opts.dryRun || errors.length) return report;
    if (!opts.consentConfirmed) {
      throw Errors.validation([
        {
          path: 'consentConfirmed',
          message: 'Confirm these members agreed to their details being stored',
        },
      ]);
    }

    const tz = (await Tenant.findById(requireTenantId()).select('settings.timezone').lean())
      ?.settings?.timezone;
    const today = parseDateOnly(todayIn(tz ?? 'Asia/Kolkata'))!;
    const recordedBy = ctx.actor.id ? new Types.ObjectId(ctx.actor.id) : undefined;
    const now = new Date();

    const session = await mongoose.startSession();
    let codes: { first: string; last: string } | undefined;
    try {
      await session.withTransaction(async () => {
        // Reserve a block of codes in one step.
        const counter = await Counter.findOneAndUpdate(
          { key: 'memberCode' },
          { $inc: { seq: valid.length } },
          { upsert: true, returnDocument: 'after', session },
        ).lean();
        const start = counter!.seq - valid.length + 1;
        const members = valid.map(({ input }, i) => {
          const _id = new Types.ObjectId();
          return {
            _id,
            memberCode: formatMemberCode(start + i),
            name: input.name,
            phone: input.phone,
            email: input.email,
            gender: input.gender,
            dateOfBirth: input.dateOfBirth,
            joinDate: input.joinDate ?? today,
            emergencyContact: input.emergencyContact,
            notes: input.notes,
            consent: { at: now, version: MEMBER_CONSENT_VERSION, recordedBy },
            userId: input.email ? new Types.ObjectId() : undefined,
          };
        });
        await Member.insertMany(members, { session });
        const logins = members.flatMap((m) =>
          m.userId
            ? [
                {
                  _id: m.userId,
                  name: m.name,
                  email: m.email,
                  role: 'member' as const,
                  memberId: m._id,
                },
              ]
            : [],
        );
        if (logins.length) await User.insertMany(logins, { session });
        codes = { first: members[0]!.memberCode, last: members.at(-1)!.memberCode };
      });
    } finally {
      await session.endSession();
    }

    await audit.record(ctx, {
      action: 'member.import',
      metadata: { count: valid.length, firstCode: codes!.first, lastCode: codes!.last },
    });
    return { ...report, created: valid.length, firstCode: codes!.first, lastCode: codes!.last };
  }

  return { run };
}
