import { INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter } from './error.filter';

/** Applies to every route: one error format. Sign-in and permissions are checked by core's AuthGuard. */
@Module({
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class HttpModule {}

/**
 * Settings shared by main.ts and the API tests.
 * TRUST_PROXY (backend/.env): set it when the API runs behind a reverse proxy (IIS, nginx), so the client's address is
 * read from X-Forwarded-For — e.g. 1 (one proxy in front) or loopback. Without it every request seems to come from the
 * proxy, and the sign-in limit per IP address would lock everyone at once. Leave it unset when clients connect directly.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  const trust = process.env.TRUST_PROXY?.trim();
  if (trust) {
    const value = /^\d+$/.test(trust) ? Number(trust) : trust === 'true' ? true : trust;
    (app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }).set('trust proxy', value);
  }
  return app.setGlobalPrefix('api');
}
