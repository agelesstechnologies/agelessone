import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PlacesService } from '../modules/core/places/places.service';

/**
 * Looks up the addresses of punch locations stored with coordinates only (no provider then, or the lookup failed).
 * Run it every 15 minutes or so (Windows Task Scheduler or cron):
 *   pnpm --filter @ageless/backend build && pnpm --filter @ageless/backend addresses:retry
 * Does nothing while GEOCODING_PROVIDER is none. Prints counts only, never locations.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const r = await app.get(PlacesService, { strict: false }).retryPending();
    console.log(`addresses:retry — resolved: ${r.resolved}; still pending: ${r.stillPending}; given up: ${r.gaveUp}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('addresses:retry failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
