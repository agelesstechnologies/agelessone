import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { fakePhone, peopleApi, tag } from '../../../test/people';

// A route with no access rule, to prove the guard closes it.
@Controller('test/no-rule')
class NoRuleController { @Get() open() { return { ok: true }; } }
@Module({ imports: [AppModule], controllers: [NoRuleController] })
class TestAppModule {}

describe('Sign-in and roles', () => {
  let app: INestApplication;
  let hr: Record<string, string>;
  let admin: Record<string, string>;
  const http = () => request(app.getHttpServer());
  const ids = (res: request.Response) => res.body.items.map((p: { publicId: string }) => p.publicId);

  /** HR creates a person, the admin gives them a login (and optionally a role); returns their ids and login. */
  async function newStaff(role?: { code: string; scope: string }) {
    const personId = await peopleApi(app, hr).createPerson();
    const login = `staff.${tag().toLowerCase()}@example.com`;
    const user = await http().post('/api/core/users').set(admin).send({ personPublicId: personId, loginEmail: login, password: 'first-pass-1' });
    expect(user.status).toBe(201);
    let assignment: string | undefined;
    if (role) {
      const a = await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode: role.code, scope: role.scope });
      expect(a.status).toBe(201);
      assignment = a.body.publicId;
    }
    return { personId, login, userId: user.body.publicId as string, assignment };
  }

  beforeAll(async () => {
    app = await createTestApp(TestAppModule);
    hr = await signIn(app, DEMO.hr.login);
    admin = await signIn(app, DEMO.admin.login);
  });
  afterAll(async () => { await app?.close(); });

  describe('signing in', () => {
    it('works with a phone number in any format, or with an email', async () => {
      const byPhone = await http().post('/api/auth/login').send({ login: '+91-00000-00001', password: 'demo-pass-1' });
      expect(byPhone.status).toBe(200);
      expect(byPhone.body).toEqual({ token: expect.any(String), expiresAt: expect.any(String) });
      const byEmail = await http().post('/api/auth/login').send({ login: 'Demo.HR@example.com', password: 'demo-pass-1' });
      expect(byEmail.status).toBe(200);
    });

    it('answers the same for a wrong password and an unknown login', async () => {
      const wrong = await http().post('/api/auth/login').send({ login: DEMO.hr.login, password: 'not-the-password' });
      const unknown = await http().post('/api/auth/login').send({ login: 'nobody@example.com', password: 'not-the-password' });
      expect([wrong.status, unknown.status]).toEqual([401, 401]);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrong.body.code).toBe('AUTH_FAILED');
    });

    it('me shows the person, roles and permissions', async () => {
      const sup = await signIn(app, DEMO.supervisor.login);
      const res = await http().get('/api/auth/me').set(sup);
      expect(res.status).toBe(200);
      expect(res.body.person).toEqual({ publicId: DEMO.supervisor.publicId, displayName: 'Demo Supervisor' });
      expect(res.body.roles).toEqual([expect.objectContaining({ code: 'supervisor', scope: 'team' })]);
      expect(res.body.permissions).toEqual({
        'hrms.people.view': 'team', 'hrms.employments.update': 'team', 'hrms.expenses.submit': 'team', 'hrms.expenses.approve': 'team',
        'hrms.attendance.punch': 'team', 'hrms.attendance.view': 'team', 'hrms.attendance.approve': 'team', 'hrms.leave.apply': 'team', 'hrms.leave.approve': 'team', 'hrms.leave.report': 'team',
        'hrms.skills.add': 'team', 'hrms.skills.verify': 'team', 'hrms.skills.view': 'team', 'hrms.dashboard.view': 'team', 'payroll.payslip.own': 'team',
        'tickets.types.view': 'team', 'tickets.types.manage': 'team',
        'tickets.view': 'team', 'tickets.work': 'team', 'tickets.manage': 'team', 'tickets.create': 'team', 'tickets.time.adjust': 'team',
      });
    });
  });

  describe('tokens', () => {
    it('no token, a broken token, an expired token are all refused', async () => {
      expect((await http().get('/api/hrms/people')).body.code).toBe('AUTH_MISSING');
      expect((await http().get('/api/hrms/people').set({ Authorization: 'Bearer not-a-token' })).body.code).toBe('AUTH_INVALID');
      const expired = new JwtService({ secret: process.env.JWT_SECRET })
        .sign({ sub: '00000000-0000-4000-8000-000000000304', tid: 1, exp: Math.floor(Date.now() / 1000) - 60 });
      const res = await http().get('/api/hrms/people').set({ Authorization: `Bearer ${expired}` });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_EXPIRED');
    });

    it('a route without an access rule is closed', async () => {
      const res = await http().get('/api/test/no-rule').set(hr);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('changing the password ends older tokens and the old password', async () => {
      const staff = await newStaff({ code: 'employee', scope: 'own' });
      const oldToken = await signIn(app, staff.login, 'first-pass-1');
      await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole seconds
      const change = await http().post('/api/auth/password').set(oldToken).send({ currentPassword: 'first-pass-1', newPassword: 'second-pass-2' });
      expect(change.status).toBe(200);
      expect((await http().get('/api/auth/me').set(oldToken)).body.code).toBe('AUTH_INVALID');
      expect((await http().get('/api/auth/me').set({ Authorization: `Bearer ${change.body.token}` })).status).toBe(200);
      expect((await http().post('/api/auth/login').send({ login: staff.login, password: 'first-pass-1' })).status).toBe(401);
      expect((await http().post('/api/auth/login').send({ login: staff.login, password: 'second-pass-2' })).status).toBe(200);
    });

    it('a person with no active job can no longer sign in, and their token stops working', async () => {
      const staff = await newStaff({ code: 'employee', scope: 'own' });
      const token = await signIn(app, staff.login, 'first-pass-1');
      const job = await peopleApi(app, hr).employmentIn(staff.personId, 'AE');
      await http().post(`/api/hrms/employments/${job}/exit`).set(hr).send({ exitOn: '2026-03-31', exitReason: 'Resigned' }).expect(200);
      expect((await http().get('/api/auth/me').set(token)).body.code).toBe('AUTH_INVALID');
      expect((await http().post('/api/auth/login').send({ login: staff.login, password: 'first-pass-1' })).body.code).toBe('AUTH_FAILED');
    });
  });

  describe('what each role may do', () => {
    it('an employee sees only themselves and changes nothing', async () => {
      const me = await signIn(app, DEMO.technician.login);
      expect(ids(await http().get('/api/hrms/people').set(me))).toEqual([DEMO.technician.publicId]);
      expect((await http().get(`/api/hrms/people/${DEMO.supervisor.publicId}`).set(me)).status).toBe(403);
      expect((await http().patch(`/api/hrms/people/${DEMO.technician.publicId}`).set(me).send({ displayName: 'X Y' })).status).toBe(403);
    });

    it('a supervisor sees themselves and their team, and changes their team\'s jobs only', async () => {
      const sup = await signIn(app, DEMO.supervisor.login);
      // other test files create people managed by the supervisor at the same time, so check membership, not the exact list
      const visible = ids(await http().get('/api/hrms/people?pageSize=100').set(sup));
      expect(visible).toEqual(expect.arrayContaining([DEMO.supervisor.publicId, DEMO.technician.publicId]));
      expect(visible).not.toContain(DEMO.engineer.publicId);
      expect(visible).not.toContain(DEMO.hr.publicId);
      expect((await http().get(`/api/hrms/people/${DEMO.engineer.publicId}`).set(sup)).status).toBe(403);

      const techJob = await peopleApi(app, hr).employmentIn(DEMO.technician.publicId, 'AE');
      const change = await http().patch(`/api/hrms/employments/${techJob}`).set(sup).send({ designation: 'Senior Technician' });
      expect(change.status).toBe(200);
      expect(change.body.employments[0].designation).toBe('Senior Technician');

      const ownJob = await peopleApi(app, hr).employmentIn(DEMO.supervisor.publicId, 'AE');
      expect((await http().patch(`/api/hrms/employments/${ownJob}`).set(sup).send({ designation: 'Boss' })).status).toBe(403);
      expect((await http().post(`/api/hrms/employments/${techJob}/exit`).set(sup).send({ exitOn: '2026-03-31', exitReason: 'Not allowed' })).status).toBe(403);
      expect((await http().post('/api/hrms/people').set(sup).send({})).status).toBe(403);
    });

    it('HR may do everything in People but cannot manage logins', async () => {
      expect((await http().get('/api/hrms/contacts/shared').query({ value: fakePhone() }).set(hr)).status).toBe(200);
      const res = await http().post('/api/core/role-assignments').set(hr).send({ personPublicId: DEMO.engineer.publicId, roleCode: 'hr', scope: 'all' });
      expect(res.status).toBe(403);
    });
  });

  describe('logins and roles (system admin)', () => {
    it('a new login gets its role, signs in, and loses access when the role ends', async () => {
      const staff = await newStaff({ code: 'hr', scope: 'all' });
      const token = await signIn(app, staff.login, 'first-pass-1');
      const me = await http().get('/api/auth/me').set(token);
      expect(me.body.permissions['hrms.people.create']).toBe('all');

      await http().post(`/api/core/role-assignments/${staff.assignment}/end`).set(admin).expect(204);
      expect((await http().get('/api/hrms/people').set(token)).status).toBe(403);
      const again = await http().post(`/api/core/role-assignments/${staff.assignment}/end`).set(admin);
      expect(again.body.code).toBe('CORE_ROLE_ALREADY_ENDED');
    });

    it('refuses a login phone or email that another login uses, and a second login for a person', async () => {
      const personId = await peopleApi(app, hr).createPerson();
      const taken = await http().post('/api/core/users').set(admin).send({ personPublicId: personId, loginPhone: '+91 00000 00001', password: 'first-pass-1' });
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('CORE_LOGIN_TAKEN');
      const second = await http().post('/api/core/users').set(admin).send({ personPublicId: DEMO.hr.publicId, loginEmail: `x.${tag().toLowerCase()}@example.com`, password: 'first-pass-1' });
      expect(second.body.code).toBe('CORE_USER_EXISTS');
    });

    it('nobody can give themselves a role', async () => {
      const res = await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: DEMO.admin.publicId, roleCode: 'hr', scope: 'all' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CORE_SELF_GRANT');
    });

    it('a reset password works and ends the person\'s tokens', async () => {
      const staff = await newStaff({ code: 'employee', scope: 'own' });
      const token = await signIn(app, staff.login, 'first-pass-1');
      await new Promise((r) => setTimeout(r, 1100));
      await http().post(`/api/core/users/${staff.userId}/reset-password`).set(admin).send({ newPassword: 'reset-pass-3' }).expect(204);
      expect((await http().get('/api/auth/me').set(token)).body.code).toBe('AUTH_INVALID');
      expect((await http().post('/api/auth/login').send({ login: staff.login, password: 'reset-pass-3' })).status).toBe(200);
    });
  });
});
