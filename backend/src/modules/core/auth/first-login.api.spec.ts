import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { fakePhone, peopleApi, tag } from '../../../test/people';
import { finishFirstLogin, latestCode, newStaff, TEMP_PASSWORD } from '../../../test/staff';
import { sentMail } from '../../../platform/mailer';
import { sentSms } from '../../../platform/sms';

type Auth = Record<string, string>;

describe('First sign-in and forgot password (codes by email); team logins', () => {
  let app: INestApplication;
  let db: pg.Client;
  let hr: Auth, admin: Auth, mgr: Auth, sup: Auth, tech: Auth;
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  /** A person with a new login (temporary password, not yet set up); answers the login email. */
  const newLogin = async () => {
    const personId = await peopleApi(app, hr).createPerson();
    const email = `new.${tag().toLowerCase()}@example.com`;
    await http().post('/api/core/users').set(admin).send({ personPublicId: personId, loginEmail: email, password: TEMP_PASSWORD }).expect(201);
    await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode: 'employee', scope: 'own' }).expect(201);
    return { personId, email };
  };
  const mailsTo = (email: string) => sentMail().filter((m) => m.to === email).length;

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, mgr, sup, tech] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.manager, DEMO.supervisor, DEMO.technician].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('a new login only reaches "who am I" and the first-login steps until the person sets their own password', async () => {
    const { email } = await newLogin();
    const temp = await signIn(app, email, TEMP_PASSWORD);
    expect((await http().get('/api/auth/me').set(temp)).body.user).toMatchObject({ loginEmail: email, mustChangePassword: true });
    expect((await http().get('/api/hrms/leave/types').set(temp)).body.code).toBe('AUTH_PASSWORD_CHANGE_REQUIRED');
    expect((await http().post('/api/auth/password').set(temp).send({ currentPassword: TEMP_PASSWORD, newPassword: 'mine-pass-1' })).status).toBe(403);

    const sent = await http().post('/api/auth/first-login/code').set(temp);
    expect(sent.status).toBe(200);
    expect(sent.body.sentTo).toMatch(/^ne\*\*\*@example\.com$/);
    const code = latestCode(email);

    const same = await http().post('/api/auth/first-login').set(temp).send({ code, newPassword: TEMP_PASSWORD });
    expect(same.body.code).toBe('AUTH_SAME_PASSWORD');
    const wrong = await http().post('/api/auth/first-login').set(temp).send({ code: code === '000000' ? '111111' : '000000', newPassword: 'mine-pass-1' });
    expect(wrong.body.code).toBe('AUTH_CODE_INVALID');

    await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole seconds
    const done = await http().post('/api/auth/first-login').set(temp).send({ code, newPassword: 'mine-pass-1' });
    expect(done.status).toBe(200);
    const mine = bearer(done.body.token);
    expect((await http().get('/api/auth/me').set(mine)).body.user.mustChangePassword).toBe(false);
    expect((await http().get('/api/hrms/leave/types').set(mine)).status).toBe(200);
    expect((await http().get('/api/auth/me').set(temp)).body.code).toBe('AUTH_INVALID');                 // the temporary token ended
    expect((await http().post('/api/auth/first-login/code').set(mine)).body.code).toBe('AUTH_SETUP_DONE');
    expect((await http().post('/api/auth/login').send({ login: email, password: TEMP_PASSWORD })).status).toBe(401);
  });

  it('an admin reset makes the person set their own password again', async () => {
    const { email } = await newLogin();
    const mine = await finishFirstLogin(app, email, TEMP_PASSWORD, 'mine-pass-1');
    const userId = (await http().get('/api/auth/me').set(mine)).body.user.publicId;
    await http().post(`/api/core/users/${userId}/reset-password`).set(admin).send({ newPassword: 'admin-pass-1' }).expect(204);
    const after = await signIn(app, email, 'admin-pass-1');
    expect((await http().get('/api/auth/me').set(after)).body.user.mustChangePassword).toBe(true);
  });

  it('codes: at most 3 an hour, 5 wrong tries end a code, an expired or used code does not work', async () => {
    const { email } = await newLogin();
    const temp = await signIn(app, email, TEMP_PASSWORD);
    for (let i = 0; i < 3; i++) await http().post('/api/auth/first-login/code').set(temp).expect(200);
    expect((await http().post('/api/auth/first-login/code').set(temp)).body.code).toBe('AUTH_CODE_LIMIT');
    const code = latestCode(email);
    const other = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await http().post('/api/auth/first-login').set(temp).send({ code: other, newPassword: 'mine-pass-1' });
    expect((await http().post('/api/auth/first-login').set(temp).send({ code, newPassword: 'mine-pass-1' })).body.code).toBe('AUTH_CODE_TOO_MANY_TRIES');
  });

  it('forgot password: the same answer for any login; a code for a real one; the new password works, the code once', async () => {
    const { email } = await newLogin();
    await finishFirstLogin(app, email, TEMP_PASSWORD, 'mine-pass-1');

    const unknown = await http().post('/api/auth/forgot-password').send({ login: `nobody.${tag()}@example.com` });
    const known = await http().post('/api/auth/forgot-password').send({ login: email });
    expect([unknown.status, known.status]).toEqual([200, 200]);
    expect(unknown.body).toEqual(known.body);
    const code = latestCode(email);

    const wrong = await http().post('/api/auth/reset-password').send({ login: email, code: code === '000000' ? '111111' : '000000', newPassword: 'reset-pass-1' });
    expect(wrong.body.code).toBe('AUTH_CODE_INVALID');
    const reset = await http().post('/api/auth/reset-password').send({ login: email, code, newPassword: 'reset-pass-1' });
    expect(reset.status).toBe(200);
    expect((await http().get('/api/auth/me').set(bearer(reset.body.token))).status).toBe(200);
    expect((await http().post('/api/auth/login').send({ login: email, password: 'mine-pass-1' })).status).toBe(401);
    expect((await http().post('/api/auth/login').send({ login: email, password: 'reset-pass-1' })).status).toBe(200);
    expect((await http().post('/api/auth/reset-password').send({ login: email, code, newPassword: 'again-pass-1' })).body.code).toBe('AUTH_CODE_NEEDED');
    const before = mailsTo('nobody@example.com');
    await http().post('/api/auth/forgot-password').send({ login: 'nobody@example.com' }).expect(200);
    expect(mailsTo('nobody@example.com')).toBe(before);
  });

  it('a login with a phone gets the code by SMS too, and can ask for it with the phone number; codes never appear in answers', async () => {
    const personId = await peopleApi(app, hr).createPerson();
    const phone = fakePhone();
    const email = `sms.${tag().toLowerCase()}@example.com`;
    await http().post('/api/core/users').set(admin).send({ personPublicId: personId, loginEmail: email, loginPhone: phone }).expect(201);
    const last4 = phone.replace(/\D/g, '').slice(-4);
    const asked = await http().post('/api/auth/forgot-password').send({ login: phone });
    expect(asked.body.devCode).toBeUndefined();
    const sms = [...sentSms()].reverse().find((m) => m.to.endsWith(last4) && /\b\d{6}\b/.test(m.text));
    const code = /\b(\d{6})\b/.exec(sms!.text)![1];
    expect(code).toBe(latestCode(email));                       // the same code by SMS and by email
    const set = await http().post('/api/auth/reset-password').send({ login: phone, code, newPassword: 'mine-pass-1' });
    expect(set.status).toBe(200);
    expect((await http().post('/api/auth/login').send({ login: phone, password: 'mine-pass-1' })).status).toBe(200);
  });

  describe('a code that cannot be sent (SMS_PROVIDER that fails)', () => {
    afterEach(() => { vi.unstubAllEnvs(); });
    /** A new login with an email, a phone and the temporary password; answers both. */
    const loginWithPhone = async () => {
      const personId = await peopleApi(app, hr).createPerson();
      const phone = fakePhone();
      const email = `fail.${tag().toLowerCase()}@example.com`;
      await http().post('/api/core/users').set(admin).send({ personPublicId: personId, loginEmail: email, loginPhone: phone, password: TEMP_PASSWORD }).expect(201);
      return { email, phone };
    };

    it('a failed message does not stop the email: the answer names only the email, and its code works', async () => {
      const { email } = await loginWithPhone();
      const temp = await signIn(app, email, TEMP_PASSWORD);
      vi.stubEnv('SMS_PROVIDER', 'broken');                              // sendSms throws
      const sent = await http().post('/api/auth/first-login/code').set(temp);
      expect(sent.status).toBe(200);
      expect(sent.body.sentTo).toMatch(/^fa\*\*\*@example\.com$/);        // no "phone ending …"
      const done = await http().post('/api/auth/first-login').set(temp).send({ code: latestCode(email), newPassword: 'mine-pass-1' });
      expect(done.status).toBe(200);
    });

    it('nothing sent: 503 AUTH_CODE_NOT_SENT; forgot password still gives its usual answer', async () => {
      const { email, phone } = await loginWithPhone();
      await db.query('UPDATE core.users SET login_email = NULL WHERE login_email = $1', [email]);   // phone only (the API always asks for an email)
      const temp = await signIn(app, phone, TEMP_PASSWORD);
      vi.stubEnv('SMS_PROVIDER', 'broken');
      const sent = await http().post('/api/auth/first-login/code').set(temp);
      expect([sent.status, sent.body.code]).toEqual([503, 'AUTH_CODE_NOT_SENT']);
      const usual = await http().post('/api/auth/forgot-password').send({ login: `nobody.${tag()}@example.com` });
      const asked = await http().post('/api/auth/forgot-password').send({ login: phone });
      expect([asked.status, asked.body]).toEqual([200, usual.body]);
    });
  });

  it('System admin sees the roles to give and a person\'s login and roles; others cannot', async () => {
    const roles = (await http().get('/api/core/roles').set(admin)).body;
    expect(roles).toEqual(expect.arrayContaining([{ code: 'supervisor', name: 'Supervisor' }, { code: 'manager', name: 'Manager' }, { code: 'employee', name: 'Employee' }]));
    const access = (await http().get(`/api/core/people/${DEMO.supervisor.publicId}/access`).set(admin)).body;
    expect(access.login).toMatchObject({ loginEmail: 'demo.supervisor@example.com', isActive: true });
    expect(access.roles.map((r: any) => r.code)).toEqual(['supervisor']);   // on site only: no Manager role
    const none = (await http().get(`/api/core/people/${await peopleApi(app, hr).createPerson()}/access`).set(admin)).body;
    expect(none).toEqual({ login: null, roles: [] });
    expect((await http().get('/api/core/roles').set(sup)).status).toBe(403);
  });

  it('a login needs an email', async () => {
    const personId = await peopleApi(app, hr).createPerson();
    const res = await http().post('/api/core/users').set(admin).send({ personPublicId: personId, loginPhone: fakePhone(), password: TEMP_PASSWORD });
    expect([res.status, res.body.code]).toEqual([400, 'VALIDATION']);
  });

  it('a manager adds people to any department of a company they work in, not to another company', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: s.personId, roleCode: 'manager', scope: 'team' }).expect(201);
    const person = (company: string) => ({
      displayName: `Added ${tag()}`, contacts: [{ kind: 'phone', value: fakePhone() }],
      employment: { legalEntityCode: company, employeeCode: `T-${tag()}`, engagementType: 'permanent', joinedOn: '2026-01-05' },
    });
    expect((await http().post('/api/hrms/people').set(s.auth).send(person('AE'))).status).toBe(201);
    const other = await http().post('/api/hrms/people').set(s.auth).send(person('ATPL'));
    expect([other.status, other.body.code]).toEqual([403, 'HRMS_NOT_YOUR_COMPANY']);
    expect((await http().post('/api/hrms/people').set(tech).send(person('AE'))).status).toBe(403);   // employees cannot
    expect((await http().post('/api/hrms/people').set(sup).send(person('AE'))).status).toBe(403);    // nor on-site supervisors
  });

  it('a manager adds someone (no manager named: the manager manages them) and gives a login with no password; the employee sets their own', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: s.personId, roleCode: 'manager', scope: 'team' }).expect(201);
    const name = `Newcomer ${tag()}`;
    const added = await http().post('/api/hrms/people').set(s.auth).send({
      displayName: name, contacts: [], employment: { legalEntityCode: 'AE', employeeCode: `T-${tag()}`, engagementType: 'permanent', joinedOn: '2026-01-05' },
    }).expect(201);
    const list = (await http().get('/api/hrms/people').query({ search: name }).set(s.auth)).body.items.map((p: any) => p.publicId);
    expect(list).toEqual([added.body.publicId]);                                  // in the manager's team list at once

    const email = `newcomer.${tag().toLowerCase()}@example.com`;
    await http().post('/api/core/users').set(s.auth).send({ personPublicId: added.body.publicId, loginEmail: email }).expect(201);
    const welcome = sentMail().filter((m) => m.to === email);
    expect(welcome).toHaveLength(1);
    expect(welcome[0].text).toContain('First time or forgot your password?');

    // the employee: "First time or forgot your password?" → code by email → own password → signed in
    await http().post('/api/auth/forgot-password').send({ login: email }).expect(200);
    const set = await http().post('/api/auth/reset-password').send({ login: email, code: latestCode(email), newPassword: 'mine-pass-1' });
    expect(set.status).toBe(200);
    const me = (await http().get('/api/auth/me').set(bearer(set.body.token))).body;
    expect(me.user.mustChangePassword).toBe(false);
    expect(me.roles).toEqual([expect.objectContaining({ code: 'employee' })]);
    expect((await http().get('/api/hrms/leave/types').set(bearer(set.body.token))).status).toBe(200);
  });

  it('a manager creates a login for someone they manage (Employee role), not for others; employees and on-site supervisors cannot', async () => {
    const mine = await http().post('/api/hrms/people').set(hr).send({
      displayName: `Team ${tag()}`, contacts: [{ kind: 'phone', value: fakePhone() }],
      employment: { legalEntityCode: 'AE', employeeCode: `T-${tag()}`, engagementType: 'permanent', joinedOn: '2026-01-05', managerPublicId: DEMO.manager.publicId },
    }).expect(201);
    // the on-site supervisor creates no login, not even for the manager's team member
    const bySup = await http().post('/api/core/users').set(sup).send({ personPublicId: mine.body.publicId, loginEmail: `s.${tag().toLowerCase()}@example.com`, password: TEMP_PASSWORD });
    expect([bySup.status, bySup.body.code]).toEqual([403, 'FORBIDDEN']);

    const email = `team.${tag().toLowerCase()}@example.com`;
    const created = await http().post('/api/core/users').set(mgr).send({ personPublicId: mine.body.publicId, loginEmail: email, password: TEMP_PASSWORD });
    expect(created.status).toBe(201);
    const own = await finishFirstLogin(app, email, TEMP_PASSWORD, 'mine-pass-1');
    const me = (await http().get('/api/auth/me').set(own)).body;
    expect(me.roles).toEqual([expect.objectContaining({ code: 'employee', scope: 'own' })]);

    const stranger = await peopleApi(app, hr).createPerson();
    const notMine = await http().post('/api/core/users').set(mgr).send({ personPublicId: stranger, loginEmail: `x.${tag().toLowerCase()}@example.com`, password: TEMP_PASSWORD });
    expect([notMine.status, notMine.body.code]).toEqual([403, 'CORE_NOT_YOUR_TEAM']);
    expect((await http().post('/api/core/users').set(tech).send({ personPublicId: stranger, loginEmail: `y.${tag().toLowerCase()}@example.com`, password: TEMP_PASSWORD })).status).toBe(403);
  });
});
