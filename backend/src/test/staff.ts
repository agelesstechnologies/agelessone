import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { signIn } from './create-app';
import { peopleApi, tag } from './people';

export interface Staff { personId: string; auth: Record<string, string>; jobs: Record<string, string> }

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
  const user = await http().post('/api/core/users').set(admin).send({ personPublicId: personId, loginEmail: login, password: 'first-pass-1' });
  if (user.status !== 201) throw new Error(`create login failed: ${user.status} ${JSON.stringify(user.body)}`);
  const role = await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode: 'employee', scope: 'own' });
  if (role.status !== 201) throw new Error(`assign role failed: ${role.status} ${JSON.stringify(role.body)}`);
  const jobs: Record<string, string> = {};
  for (const company of companies) jobs[company] = await people.employmentIn(personId, company);
  return { personId, auth: await signIn(app, login, 'first-pass-1'), jobs };
}
