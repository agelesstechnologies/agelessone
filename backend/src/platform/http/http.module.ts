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
  return app.setGlobalPrefix('api');
}
