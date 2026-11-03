import { INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ErrorFilter } from './error.filter';
import { RequestContextGuard } from './request-context';

/** Applies to every route: one error format, and a caller on every non-public request. */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: APP_GUARD, useClass: RequestContextGuard }, // TEMP: replace with login
  ],
})
export class HttpModule {}

/** Settings shared by main.ts and the API tests. */
export function configureApp(app: INestApplication): INestApplication {
  return app.setGlobalPrefix('api');
}
