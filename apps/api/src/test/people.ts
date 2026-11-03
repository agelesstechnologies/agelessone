import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { callerHeaders } from './create-app';

// Fictional data only. Unique suffixes keep tests independent of each other.
export const SUPERVISOR = '00000000-0000-4000-8000-000000000001'; // seeded 'Demo Supervisor'
export const tag = () => randomUUID().slice(0, 8).toUpperCase();
/** A made-up number in the 00000 range, unique per call. */
export const fakePhone = () => `+91 00000 ${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;

export interface PeopleApi {
  http(): request.Agent;
  createPerson(over?: { phone?: string; company?: string; joinedOn?: string }): Promise<string>;
  addEmployment(personId: string, company: string, joinedOn?: string): Promise<request.Response>;
  get(personId: string): Promise<any>; // response JSON; the tests check its shape
  employmentIn(personId: string, company: string): Promise<string>;
}

export function peopleApi(app: INestApplication): PeopleApi {
  const http = () => request(app.getHttpServer());
  return {
    http,
    /** Creates a person with one phone and one employment; returns the person's public id. */
    async createPerson(over: { phone?: string; company?: string; joinedOn?: string } = {}): Promise<string> {
      const t = tag();
      const res = await http().post('/api/hrms/people').set(callerHeaders).send({
        displayName: `Test Person ${t}`,
        contacts: [{ kind: 'phone', value: over.phone ?? fakePhone() }],
        employment: { legalEntityCode: over.company ?? 'AE', employeeCode: `T-${t}`, engagementType: 'permanent', joinedOn: over.joinedOn ?? '2026-01-05' },
      });
      if (res.status !== 201) throw new Error(`createPerson failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.publicId;
    },
    async addEmployment(personId: string, company: string, joinedOn = '2026-02-01') {
      return http().post(`/api/hrms/people/${personId}/employments`).set(callerHeaders)
        .send({ legalEntityCode: company, employeeCode: `T-${tag()}`, engagementType: 'contract', joinedOn });
    },
    async get(personId: string) {
      const res = await http().get(`/api/hrms/people/${personId}`).set(callerHeaders);
      return res.body;
    },
    /** The public id of the person's employment in a company. */
    async employmentIn(personId: string, company: string): Promise<string> {
      const p = await this.get(personId);
      return p.employments.find((e: { company: { code: string } }) => e.company.code === company).publicId;
    },
  };
}
