import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { StockRebuildService } from '../modules/inventory/application/stock-rebuild.service';

/**
 * The nightly inventory job (Windows Task Scheduler or cron), e.g. every night at 02:00 IST:
 *   pnpm --filter @ageless/backend build && pnpm --filter @ageless/backend inventory:daily
 * It rebuilds every stock balance and valuation from the stock moves, fixes any that differ and alerts: each company with
 * a difference gets an audit entry inventory.stock.rebuilt listing them, and the job prints them. Posting waits while it runs.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(StockRebuildService, { strict: false }).rebuild();
    const total = result.balances.length + result.valuations.length;
    console.log(`inventory:daily — stock rebuilt from the moves: ${total === 0 ? 'every balance matched' : `${total} differences fixed (see the audit log)`}`);
    for (const d of [...result.balances, ...result.valuations]) console.warn('inventory:daily — difference', JSON.stringify(d));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('inventory:daily failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
