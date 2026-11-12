import 'reflect-metadata';
import { INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { configureApp } from '../platform/http/http.module';

/** Starts the real app (same settings as main.ts) for Supertest; DATABASE_URL points at the test database. */
export async function createTestApp(rootModule: Type<unknown>): Promise<INestApplication> {
  const app = configureApp(await NestFactory.create(rootModule, { logger: false }));
  await app.init();
  return app;
}

/** Seeded fictional logins (scripts/db-seed.mjs). All share the development password. */
export const DEMO_PASSWORD = 'demo-pass-1';
export const DEMO = {
  // Supervisor, team: on site only (site work of the tickets they supervise); leads no team, adds nobody, approves nothing
  supervisor: { login: '+91 00000 00001', publicId: '00000000-0000-4000-8000-000000000001' },
  technician: { login: '+910000000002', publicId: '00000000-0000-4000-8000-000000000002' },   // Employee, own; reports to the manager (AE)
  engineer: { login: 'demo.engineer@example.com', publicId: '00000000-0000-4000-8000-000000000003' }, // Employee, own
  hr: { login: 'demo.hr@example.com', publicId: '00000000-0000-4000-8000-000000000004' },       // HR, all
  admin: { login: 'demo.admin@example.com', publicId: '00000000-0000-4000-8000-000000000005' }, // System admin, all
  ceo: { login: 'demo.ceo@example.com', publicId: '00000000-0000-4000-8000-000000000006' },     // CEO, team (last leave approver)
  head: { login: 'demo.head@example.com', publicId: '00000000-0000-4000-8000-000000000008' },   // Manager, team; head of Designing (ATPL)
  // Manager, team: jobs in ATPL (Designing, reports to the head) and AE; leads the AE team (the technician reports to them)
  manager: { login: '+91 00000 00009', publicId: '00000000-0000-4000-8000-000000000009' },
};

/** Signs in and returns the Authorization header to .set() on requests. */
export async function signIn(app: INestApplication, login: string, password = DEMO_PASSWORD): Promise<Record<string, string>> {
  const res = await request(app.getHttpServer()).post('/api/auth/login').send({ login, password });
  if (res.status !== 200) throw new Error(`sign-in failed for ${login}: ${res.status} ${JSON.stringify(res.body)}`);
  return { Authorization: `Bearer ${res.body.token}` };
}
