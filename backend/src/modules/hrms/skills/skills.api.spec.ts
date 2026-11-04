import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { addDays, todayIst } from '../../../platform/time';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { tag } from '../../../test/people';
import { newStaff, Staff } from '../../../test/staff';
import { SkillsService } from './application/skills.service';

type Auth = Record<string, string>;
const PDF = Buffer.from('%PDF-1.4\n% certificate\n');

describe('HRMS skills and certificates API', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, sup: Auth, tech: Auth;
  let db: pg.Client;
  const http = () => request(app.getHttpServer());
  /** A new ATPL employee managed by Demo Supervisor. */
  const staff = async () => {
    const s = await newStaff(app, hr, admin, ['ATPL']);
    await http().patch(`/api/hrms/employments/${s.jobs.ATPL}`).set(hr).send({ managerPublicId: DEMO.supervisor.publicId, departmentCode: 'ATS' }).expect(200);
    return s;
  };
  const newSkill = async (name = 'Node.js') => (await http().post('/api/hrms/skills').set(hr)
    .send({ company: 'ATPL', departmentCode: 'ATS', code: `skill-${tag().toLowerCase()}`, name }).expect(201)).body;
  const addCert = (s: Staff, fields: Record<string, string>, file?: Buffer) => {
    let r = http().post(`/api/hrms/people/${s.personId}/certificates`).set(s.auth);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return file ? r.attach('file', file, 'cert.pdf') : r;
  };

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, sup, tech] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.supervisor, DEMO.technician].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('HR keeps the skills list per company and department; a person adds their skill and the manager verifies it', async () => {
    const skill = await newSkill();
    expect(skill).toMatchObject({ company: 'ATPL', department: { code: 'ATS' }, name: 'Node.js' });
    expect((await http().post('/api/hrms/skills').set(tech).send({ company: 'ATPL', code: 'x-1', name: 'Nope' })).status).toBe(403);

    const s = await staff();
    const added = await http().post(`/api/hrms/people/${s.personId}/skills`).set(s.auth).send({ skillPublicId: skill.publicId, level: 'skilled' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ level: 'skilled', verifiedBy: null, skill: { code: skill.code } });

    const verified = await http().post(`/api/hrms/person-skills/${added.body.publicId}/verify`).set(sup);
    expect(verified.body).toMatchObject({ verifiedBy: { publicId: DEMO.supervisor.publicId } });
    // a new level needs verifying again
    const raised = await http().post(`/api/hrms/people/${s.personId}/skills`).set(s.auth).send({ skillPublicId: skill.publicId, level: 'expert' });
    expect(raised.body).toMatchObject({ publicId: added.body.publicId, level: 'expert', verifiedBy: null });

    const matrix = await http().get('/api/hrms/skills/matrix').query({ company: 'ATPL', department: 'ATS', skill: skill.code }).set(hr);
    expect(matrix.body.rows.map((r: { person: { publicId: string } }) => r.person.publicId)).toEqual([s.personId]);
    const own = await http().get('/api/hrms/skills/matrix').set(s.auth); // own scope: only themselves
    expect(own.body.rows.every((r: { person: { publicId: string } }) => r.person.publicId === s.personId)).toBe(true);
  });

  it('nobody verifies their own skill or certificate', async () => {
    const skill = await newSkill('Excel');
    const mine = await http().post(`/api/hrms/people/${DEMO.hr.publicId}/skills`).set(hr).send({ skillPublicId: skill.publicId, level: 'expert' });
    const self = await http().post(`/api/hrms/person-skills/${mine.body.publicId}/verify`).set(hr);
    expect([self.status, self.body.code]).toEqual([403, 'HRMS_SELF_VERIFICATION']);

    const cert = await http().post(`/api/hrms/people/${DEMO.hr.publicId}/certificates`).set(hr).field('name', 'Payroll course');
    const selfCert = await http().post(`/api/hrms/certificates/${cert.body.publicId}/verify`).set(hr);
    expect(selfCert.body.code).toBe('HRMS_SELF_VERIFICATION');

    const stranger = await newStaff(app, hr, admin, ['ATPL']); // not in the supervisor's team
    const theirs = await http().post(`/api/hrms/people/${stranger.personId}/skills`).set(stranger.auth).send({ skillPublicId: skill.publicId, level: 'trainee' });
    expect((await http().post(`/api/hrms/person-skills/${theirs.body.publicId}/verify`).set(sup)).status).toBe(403);
  });

  it('certificates: file kept and checked, expiry list correct, the daily job marks expired ones', async () => {
    const s = await staff();
    const today = todayIst();
    const soon = await addCert(s, { name: 'Electrical safety', issuer: 'Test Board', number: 'TB-0001', issuedOn: addDays(today, -300), expiresOn: addDays(today, 10) }, PDF);
    expect(soon.status).toBe(201);
    expect(soon.body).toMatchObject({ status: 'review', hasFile: true, expiresOn: addDays(today, 10) });
    const later = await addCert(s, { name: 'Working at height', expiresOn: addDays(today, 40) });
    const edge = await addCert(s, { name: 'First aid', expiresOn: addDays(today, 30) });
    const past = await addCert(s, { name: 'Old licence', expiresOn: addDays(today, -1) });
    expect(past.body.status).toBe('expired');
    expect((await addCert(s, { name: 'Bad file' }, Buffer.from('nope'))).body.code).toBe('HRMS_FILE_TYPE');

    const list = await http().get('/api/hrms/certificates/expiring').query({ days: 30 }).set(hr);
    expect(list.status).toBe(200);
    const mine = list.body.certificates.filter((c: { person: { publicId: string } }) => c.person.publicId === s.personId);
    expect(mine.map((c: { name: string; daysLeft: number }) => [c.name, c.daysLeft])).toEqual([['Electrical safety', 10], ['First aid', 30]]);
    expect(mine.map((c: { publicId: string }) => c.publicId)).not.toContain(later.body.publicId);
    expect(edge.status).toBe(201);
    expect((await http().get('/api/hrms/certificates/expiring').set(sup)).status).toBe(403);

    // file: the person and their manager may fetch it, others may not
    expect((await http().get(`/api/hrms/certificates/${soon.body.publicId}/file`).set(sup)).headers['content-type']).toBe('application/pdf');
    expect((await http().get(`/api/hrms/certificates/${soon.body.publicId}/file`).set(tech)).status).toBe(403);

    // the date passes without the job having run: shown as expired at once, stored as expired by the job
    await db.query(`UPDATE hrms.certificates SET expires_on = $2 WHERE public_id = $1`, [soon.body.publicId, addDays(today, -1)]);
    const matrix = await http().get('/api/hrms/skills/matrix').query({ company: 'ATPL' }).set(hr);
    const row = matrix.body.rows.find((r: { person: { publicId: string } }) => r.person.publicId === s.personId);
    expect(row.certificates.find((c: { publicId: string }) => c.publicId === soon.body.publicId).status).toBe('expired');
    expect((await http().post(`/api/hrms/certificates/${soon.body.publicId}/verify`).set(sup)).body.code).toBe('HRMS_CERTIFICATE_EXPIRED');

    const result = await app.get(SkillsService, { strict: false }).runDaily();
    expect(result.markedExpired).toBeGreaterThanOrEqual(1);
    const { rows } = await db.query('SELECT status FROM hrms.certificates WHERE public_id = $1', [soon.body.publicId]);
    expect(rows[0].status).toBe('expired');

    expect((await http().post(`/api/hrms/certificates/${later.body.publicId}/verify`).set(sup)).body).toMatchObject({ status: 'verified' });
  });
});
