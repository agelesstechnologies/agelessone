import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { signIn } from './create-app';
import { peopleApi, tag } from './people';
import { sentMail } from '../platform/mailer';

/** The temporary password a new test login gets; finishFirstLogin replaces it with the person's own. */
export const TEMP_PASSWORD = 'temp-pass-1';

/**
 * A new login's first sign-in, as a person does it: sign in with the temporary password, ask for the emailed code
 * (EMAIL_PROVIDER=memory in tests), then set their own password with it. Answers the signed-in headers.
 */
export async function finishFirstLogin(app: INestApplication, login: string, tempPassword: string, newPassword: string): Promise<Record<string, string>> {
  const http = () => request(app.getHttpServer());
  const temp = await signIn(app, login, tempPassword);
  const sent = await http().post('/api/auth/first-login/code').set(temp);
  if (sent.status !== 200) throw new Error(`first-login code failed: ${sent.status} ${JSON.stringify(sent.body)}`);
  const code = latestCode(login);
  const done = await http().post('/api/auth/first-login').set(temp).send({ code, newPassword });
  if (done.status !== 200) throw new Error(`first login failed: ${done.status} ${JSON.stringify(done.body)}`);
  return { Authorization: `Bearer ${done.body.token}` };
}

/** The 6-digit code in the newest email to this address (tests only). */
export function latestCode(email: string): string {
  const mail = [...sentMail()].reverse().find((m) => m.to === email);
  const code = mail && /\b(\d{6})\b/.exec(mail.text)?.[1];
  if (!code) throw new Error(`no code emailed to ${email}`);
  return code;
}

export interface Staff { personId: string; login: string; auth: Record<string, string>; jobs: Record<string, string> }

/**
 * A brand-new fictional employee with a login (Employee role, scope own) and one job per company given,
 * so a test can punch without affecting anyone else. hr and admin are signed-in Demo HR and Demo Admin.
 */
export async function newStaff(app: INestApplication, hr: Record<string, string>, admin: Record<string, string>, companies: string[] = ['AE']): Promise<Staff> {
  const people = peopleApi(app, hr);
  const [first, ...more] = companies;
  const personId = await people.createPerson({ company: first, joinedOn: '2025-04-01' });
  for (const company of more) {
    const res = await people.addEmployment(personId, company, '2025-04-01');
    if (res.status !== 201) throw new Error(`addEmployment failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const login = `staff.${tag().toLowerCase()}@example.com`;
  const http = () => request(app.getHttpServer());
  const user = await http().post('/api/core/users').set(admin).send({ personPublicId: personId, loginEmail: login, password: TEMP_PASSWORD });
  if (user.status !== 201) throw new Error(`create login failed: ${user.status} ${JSON.stringify(user.body)}`);
  await finishFirstLogin(app, login, TEMP_PASSWORD, 'first-pass-1');
  const role = await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode: 'employee', scope: 'own' });
  if (role.status !== 201) throw new Error(`assign role failed: ${role.status} ${JSON.stringify(role.body)}`);
  const jobs: Record<string, string> = {};
  for (const company of companies) jobs[company] = await people.employmentIn(personId, company);
  return { personId, login, auth: await signIn(app, login, 'first-pass-1'), jobs };
}
