import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SkillsService } from '../modules/hrms/skills/application/skills.service';

/**
 * The once-a-day HRMS job: run it from Windows Task Scheduler or cron, e.g. every morning at 06:00 IST:
 *   pnpm --filter @ageless/backend build && pnpm --filter @ageless/backend hrms:daily
 * Today it stores certificates past their date as expired and counts those expiring within 30 days
 * (HR sees that list at GET /api/hrms/certificates/expiring). Notifications come later.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(SkillsService, { strict: false }).runDaily();
    console.log(`hrms:daily — certificates marked expired: ${result.markedExpired}; expiring within 30 days: ${result.expiringWithin30Days}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('hrms:daily failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
