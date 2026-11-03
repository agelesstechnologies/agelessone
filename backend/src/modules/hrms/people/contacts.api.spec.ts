import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../../app.module';
import { callerHeaders, createTestApp } from '../../../test/create-app';
import { fakePhone, peopleApi } from '../../../test/people';

interface Contact { publicId: string; kind: string; value: string; isPrimary: boolean; endedAt: string | null }
const stored = (phone: string) => phone.replace(/[\s-]/g, '');

describe('HRMS contacts and person changes API', () => {
  let app: INestApplication;
  let api: ReturnType<typeof peopleApi>;
  const phones = async (personId: string): Promise<Contact[]> =>
    (await api.get(personId)).contacts.filter((c: Contact) => c.kind === 'phone');

  beforeAll(async () => { app = await createTestApp(AppModule); api = peopleApi(app); });
  afterAll(async () => { await app?.close(); });

  it('adds a contact another person already uses, and the shared list shows both people', async () => {
    const phone = fakePhone();
    const a = await api.createPerson({ phone });
    const b = await api.createPerson();
    const add = await api.http().post(`/api/hrms/people/${b}/contacts`).set(callerHeaders)
      .send({ kind: 'phone', value: phone.replace(/ /g, '-'), label: 'family' });
    expect(add.status).toBe(201);

    const shared = await api.http().get('/api/hrms/contacts/shared').query({ value: phone }).set(callerHeaders);
    expect(shared.status).toBe(200);
    expect(shared.body.value).toBe(stored(phone));
    expect(shared.body.people.map((p: { publicId: string }) => p.publicId).sort()).toEqual([a, b].sort());
    // never merged: still two separate people
    expect(a).not.toBe(b);
  });

  it('a new primary contact takes over from the current primary of that kind', async () => {
    const first = fakePhone();
    const p = await api.createPerson({ phone: first });
    const second = fakePhone();
    await api.http().post(`/api/hrms/people/${p}/contacts`).set(callerHeaders).send({ kind: 'phone', value: second, isPrimary: true }).expect(201);
    const list = await phones(p);
    expect(list.find((c) => c.value === stored(first))?.isPrimary).toBe(false);
    expect(list.find((c) => c.value === stored(second))?.isPrimary).toBe(true);
  });

  it('ending a contact keeps it in history; no primary of that kind until another is set', async () => {
    const phone = fakePhone();
    const p = await api.createPerson({ phone });
    const [contact] = await phones(p);

    const end = await api.http().post(`/api/hrms/contacts/${contact.publicId}/end`).set(callerHeaders);
    expect(end.status).toBe(204);
    const after = await phones(p);
    expect(after).toHaveLength(1); // still there: nothing is deleted
    expect(after[0]).toMatchObject({ publicId: contact.publicId, value: stored(phone), endedAt: expect.any(String) });
    expect(after.filter((c) => c.isPrimary && c.endedAt === null)).toHaveLength(0);

    const shared = await api.http().get('/api/hrms/contacts/shared').query({ value: phone }).set(callerHeaders);
    expect(shared.body.people.map((x: { publicId: string }) => x.publicId)).not.toContain(p);

    const again = await api.http().post(`/api/hrms/contacts/${contact.publicId}/end`).set(callerHeaders);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('HRMS_CONTACT_ALREADY_ENDED');

    const next = fakePhone();
    await api.http().post(`/api/hrms/people/${p}/contacts`).set(callerHeaders).send({ kind: 'phone', value: next, isPrimary: true }).expect(201);
    expect((await phones(p)).filter((c) => c.isPrimary && c.endedAt === null).map((c) => c.value)).toEqual([stored(next)]);
  });

  it('changes a person\'s display name and status', async () => {
    const p = await api.createPerson();
    const res = await api.http().patch(`/api/hrms/people/${p}`).set(callerHeaders).send({ displayName: 'Renamed Test Person', status: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ publicId: p, displayName: 'Renamed Test Person', status: 'inactive' });

    const empty = await api.http().patch(`/api/hrms/people/${p}`).set(callerHeaders).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('VALIDATION');
  });
});
