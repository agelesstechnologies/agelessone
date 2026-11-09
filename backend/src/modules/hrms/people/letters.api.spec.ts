import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { fakePhone, tag } from '../../../test/people';

type Auth = Record<string, string>;
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

describe('Employee codes in the form, and joining letters', () => {
  let app: INestApplication;
  let hr: Auth, ceo: Auth, sup: Auth, tech: Auth;
  let dept: { publicId: string; codePrefix: string };
  let job: string;
  const http = () => request(app.getHttpServer());
  const nextCode = (who: Auth) => http().get(`/api/hrms/departments/${dept.publicId}/next-employee-code`).set(who);
  const createInDept = (name: string) => http().post('/api/hrms/people').set(hr).send({
    displayName: name, fullName: `${name} Kumar`, contacts: [{ kind: 'phone', value: fakePhone() }],
    employment: { legalEntityCode: 'AE', departmentCode: dept.codePrefix, designation: 'Technician', engagementType: 'permanent', joinedOn: '2026-12-01' },
  });

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, ceo, sup, tech] = await Promise.all([DEMO.hr, DEMO.ceo, DEMO.supervisor, DEMO.technician].map((d) => signIn(app, d.login)));
    const prefix = letters();
    dept = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Letters ${tag()}`, codePrefix: prefix }).expect(201)).body;
  });
  afterAll(async () => { await app?.close(); });

  it('the form shows the next employee code for a department; saving without a code takes it', async () => {
    const before = await nextCode(hr);
    expect(before.body).toEqual({ department: dept.publicId, codePrefix: dept.codePrefix, code: `${dept.codePrefix}001` });
    const created = await createInDept(`Asha ${tag()}`);
    expect(created.status).toBe(201);
    const person = (await http().get(`/api/hrms/people/${created.body.publicId}`).set(hr)).body;
    expect(person.employments[0].employeeCode).toBe(`${dept.codePrefix}001`);
    job = person.employments[0].publicId;
    expect((await nextCode(hr)).body.code).toBe(`${dept.codePrefix}002`);
    expect((await nextCode(tech)).status).toBe(403);
    expect((await http().get(`/api/hrms/departments/${randomUUID()}/next-employee-code`).set(hr)).status).toBe(404);
  });

  it('a template: built-in until saved; HR saves its own; a misspelt fill-in is refused', async () => {
    const builtIn = (await http().get('/api/hrms/letter-templates/AE/joining').set(hr)).body;
    expect(builtIn).toMatchObject({ company: 'AE', kind: 'joining', fields: expect.arrayContaining(['name', 'joiningDate']) });
    const bad = await http().put('/api/hrms/letter-templates/AE/joining').set(hr).send({ title: 'Welcome', body: 'Dear {{nmae}}' });
    expect([bad.status, bad.body.code, bad.body.details.unknown]).toEqual([400, 'HRMS_LETTER_UNKNOWN_FIELD', ['nmae']]);
    const saved = await http().put('/api/hrms/letter-templates/AE/joining').set(hr)
      .send({ title: 'Welcome to {{company}}', body: 'Dear {{fullName}},\n\nYou join as {{designation}} ({{employeeCode}}) on {{joiningDate}}.' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ isDefault: false, title: 'Welcome to {{company}}', updatedBy: { publicId: DEMO.hr.publicId } });
    expect((await http().get('/api/hrms/letter-templates/XX/joining').set(hr)).body.code).toBe('HRMS_UNKNOWN_COMPANY');
  });

  it('the draft is the template filled with the job; issuing keeps the text once; the PDF downloads', async () => {
    const draft = (await http().get(`/api/hrms/employments/${job}/joining-letter`).set(hr)).body;
    expect(draft.title).toBe('Welcome to Ageless Entertainments');
    expect(draft.body).toContain(`Technician (${dept.codePrefix}001) on 1 December 2026`);

    const id = randomUUID();
    const body = `${draft.body}\n\nAdjusted for this person.`;
    const issued = await http().post(`/api/hrms/employments/${job}/joining-letters`).set(ceo).send({ publicId: id, title: draft.title, body });
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ publicId: id, kind: 'joining', body, issuedBy: { publicId: DEMO.ceo.publicId } });
    const again = await http().post(`/api/hrms/employments/${job}/joining-letters`).set(ceo).send({ publicId: id, title: 'Other', body: 'Other' });
    expect([again.status, again.body.body]).toEqual([200, body]);
    expect((await http().get(`/api/hrms/employments/${job}/joining-letters`).set(hr)).body.map((l: any) => l.publicId)).toEqual([id]);

    const pdf = await http().get(`/api/hrms/letters/${id}/pdf`).set(hr).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).toString('latin1')).toContain('(Adjusted for this person.)');
  });

  it('only HR and Management: supervisors and employees get 403', async () => {
    for (const who of [sup, tech]) {
      expect((await http().get('/api/hrms/letter-templates/AE/joining').set(who)).status).toBe(403);
      expect((await http().get(`/api/hrms/employments/${job}/joining-letter`).set(who)).status).toBe(403);
      expect((await http().post(`/api/hrms/employments/${job}/joining-letters`).set(who).send({ title: 't', body: 'b' })).status).toBe(403);
    }
  });
});
