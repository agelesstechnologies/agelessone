import 'reflect-metadata';
import { INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureApp } from '../platform/http/http.module';

/** Starts the real app (same settings as main.ts) for Supertest; DATABASE_URL points at the test database. */
export async function createTestApp(rootModule: Type<unknown>): Promise<INestApplication> {
  const app = configureApp(await NestFactory.create(rootModule, { logger: false }));
  await app.init();
  return app;
}

/** Caller headers for the seeded fictional supervisor. TEMP: replace with login. */
export const callerHeaders = { 'x-tenant-id': '1', 'x-person-id': '00000000-0000-4000-8000-000000000001' };
