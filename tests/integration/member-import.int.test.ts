import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog, Member, User } from '../../src/db/models.js';
import { runInTenant } from '../../src/tenancy/context.js';
import { connectTestDb, describeWithDb, dropAndDisconnect } from '../helpers/db.js';
import { FZ, PH, gymId, intApp, resetDemo } from '../helpers/int.js';

const { mailer, call, tokenFor, memberToken } = intApp();

const GOOD = [
  '﻿Name,Mobile,Email,Gender,DOB,Join Date,Emergency Contact Name,Emergency Contact Phone,Notes',
  'Asha Verma,98700 00001,Asha@Member.demo,Female,05/03/1992,01/01/2026,Ravi Verma,9870000099,"Prefers evenings, 6-8pm"',
  'Bala Murugan,+91 98700 00002,,male,,2025-12-15,,,',
  'Chitra Rao,9870000003,chitra@member.demo,,1988-11-30,,,,"Says ""hi"""',
].join('\r\n');

const memberCount = async (slug = 'powerhouse') =>
  runInTenant(await gymId(slug), () => Member.countDocuments());

describeWithDb('CSV member import (real MongoDB)', () => {
  let owner: string;

  beforeAll(async () => {
    await connectTestDb(`import_${Date.now()}`);
  });
  afterAll(dropAndDisconnect);
  beforeEach(async () => {
    await resetDemo(mailer);
    owner = await tokenFor(PH, 'owner@powerhouse.demo');
  });

  const upload = (csv: string, query: string, token = owner, host = PH) =>
    call('post', host, `/members/import?${query}`, token).set('Content-Type', 'text/csv').send(csv);

  it('dry run validates and writes nothing (dry run is the default)', async () => {
    const res = await upload(GOOD, '');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      dryRun: true,
      total: 3,
      valid: 3,
      errorCount: 0,
      created: 0,
    });
    expect(await memberCount()).toBe(4);
  });

  it('imports all rows with codes, Indian dates, header aliases, quoted notes and logins', async () => {
    const res = await upload(GOOD, 'dryRun=false&consentConfirmed=true');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ created: 3, firstCode: 'M0005', lastCode: 'M0007' });

    const ph = await gymId('powerhouse');
    const asha = await runInTenant(ph, () => Member.findOne({ phone: '+919870000001' }).lean());
    expect(asha).toMatchObject({
      memberCode: 'M0005',
      email: 'asha@member.demo',
      gender: 'female',
      notes: 'Prefers evenings, 6-8pm',
      emergencyContact: { name: 'Ravi Verma', phone: '+919870000099' },
      consent: { version: 'v1' },
    });
    expect(asha!.dateOfBirth!.toISOString().slice(0, 10)).toBe('1992-03-05');
    expect(asha!.joinDate.toISOString().slice(0, 10)).toBe('2026-01-01');
    const chitra = await runInTenant(ph, () => Member.findOne({ phone: '+919870000003' }).lean());
    expect(chitra!.notes).toBe('Says "hi"');

    // Members with an email can sign in right away; Bala (no email) has no login.
    expect(await memberToken(PH, 'asha@member.demo')).toBeTruthy();
    expect(await runInTenant(ph, () => User.countDocuments({ role: 'member' }))).toBe(5);

    const log = await runInTenant(ph, () => AuditLog.findOne({ action: 'member.import' }).lean());
    expect(log!.metadata).toMatchObject({ count: 3, firstCode: 'M0005', lastCode: 'M0007' });
    // Codes continue after the import.
    const next = await call('post', PH, '/members', owner).send({
      name: 'Next',
      phone: '9870000010',
      consent: true,
    });
    expect(next.body.data.memberCode).toBe('M0008');
  });

  it('reports every bad row with line and column; a real import with errors writes nothing', async () => {
    const csv = [
      'name,phone,email,date_of_birth,join_date',
      'Good One,9870000001,,,',
      ',9870000002,,,', // no name
      'Bad Phone,12345,,,',
      'Dup In File,9870000001,,,', // same phone as line 2
      'Existing,98111 11111,,,', // Arjun's phone
      'Staff Email,9870000005,desk@powerhouse.demo,,',
      'Bad Dates,9870000006,,31/02/1990,2099-01-01',
    ].join('\n');
    const dry = await upload(csv, 'dryRun=true');
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ total: 7, valid: 1 });
    const errs = dry.body.data.errors as { row: number; field: string }[];
    expect(errs.map((e) => [e.row, e.field])).toEqual([
      [3, 'name'],
      [4, 'phone'],
      [5, 'phone'],
      [6, 'phone'],
      [7, 'email'],
      [8, 'date_of_birth'],
      [8, 'join_date'],
    ]);
    expect(JSON.stringify(dry.body)).not.toContain('9811111111');

    const real = await upload(csv, 'dryRun=false&consentConfirmed=true');
    expect(real.status).toBe(422);
    expect(real.body.error.code).toBe('IMPORT_INVALID');
    expect(real.body.error.details.errorCount).toBe(7);
    expect(await memberCount()).toBe(4);
  });

  it('a real import needs consent confirmation', async () => {
    const res = await upload(GOOD, 'dryRun=false');
    expect(res.status).toBe(422);
    expect(await memberCount()).toBe(4);
  });

  it('400 for an empty file, missing required columns, JSON instead of CSV, or too many rows', async () => {
    expect((await upload('', 'dryRun=true')).status).toBe(400);
    expect((await upload('name,phone\n', 'dryRun=true')).status).toBe(400);
    const noPhone = await upload('name,email\nA,a@b.in', 'dryRun=true');
    expect(noPhone.status).toBe(400);
    expect(noPhone.body.error.message).toMatch(/phone/);
    const json = await call('post', PH, '/members/import', owner).send({ csv: GOOD });
    expect(json.status).toBe(400);
    const big = [
      'name,phone',
      ...Array.from({ length: 2001 }, (_, i) => `M ${i},98${String(i).padStart(8, '0')}`),
    ].join('\n');
    expect((await upload(big, 'dryRun=true')).status).toBe(400);
    expect((await upload(GOOD, 'dryRun=maybe')).status).toBe(422);
  });

  it('authorization: staff need the members:import grant; members and anonymous are refused', async () => {
    const desk = await tokenFor(PH, 'desk@powerhouse.demo');
    expect((await upload(GOOD, 'dryRun=true', desk)).status).toBe(403);
    const deskId = await runInTenant(await gymId('powerhouse'), async () =>
      String((await User.findOne({ email: 'desk@powerhouse.demo' }).lean())!._id),
    );
    await call('patch', PH, `/staff/${deskId}`, owner).send({ permissions: ['members:import'] });
    expect((await upload(GOOD, 'dryRun=false&consentConfirmed=true', desk)).status).toBe(201);

    const arjun = await memberToken(PH, 'arjun@member.demo');
    expect((await upload(GOOD, 'dryRun=true', arjun)).status).toBe(403);
    expect(
      (await call('post', PH, '/members/import').set('Content-Type', 'text/csv').send(GOOD)).status,
    ).toBe(401);
  });

  it('cross-tenant: an import lands only in the host gym; duplicates are checked per gym', async () => {
    const fzOwner = await tokenFor(FZ, 'owner@fitzone.demo');
    // Priya's Powerhouse phone and email are free in FitZone.
    const csv = 'name,phone,email\nPriya Nair,9811111112,priya@member.demo';
    const res = await upload(csv, 'dryRun=false&consentConfirmed=true', fzOwner, FZ);
    expect(res.status).toBe(201);
    expect(await memberCount('fitzone')).toBe(5);
    expect(await memberCount('powerhouse')).toBe(4);
    expect((await upload(csv, 'dryRun=true', fzOwner, PH)).status).toBe(401);
  });
});
