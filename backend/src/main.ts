import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './platform/http/http.module';
import { serveApiDocs } from './platform/http/openapi';

async function bootstrap() {
  const app = configureApp(await NestFactory.create(AppModule));
  serveApiDocs(app); // http://localhost:3000/api/docs
  await app.listen(Number(process.env.PORT ?? 3000));
}
bootstrap();
