import { INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ErrorFilter } from './error.filter';

/** Applies to every route: one error format. Sign-in and permissions are checked by core's AuthGuard. */
@Module({
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class HttpModule {}

/** Settings shared by main.ts and the API tests. */
export function configureApp(app: INestApplication): INestApplication {
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  return app.setGlobalPrefix('api');
}
