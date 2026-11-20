import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { StockRebuildService } from '../modules/inventory/application/stock-rebuild.service';
import { RequestsService } from '../modules/inventory/application/requests.service';

/**
 * The nightly inventory job (Windows Task Scheduler or cron), e.g. every night at 02:00 IST:
 *   pnpm --filter @ageless/backend build && pnpm --filter @ageless/backend inventory:daily
 * It releases part requests whose reservation ran out (expired) or whose ticket is closed, then rebuilds every stock balance and
 * valuation from the stock moves (and reserved from the open reservations), fixes any that differ and alerts: each company with
 * a difference gets an audit entry inventory.stock.rebuilt listing them, and the job prints them. Posting waits while it runs.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const released = await app.get(RequestsService, { strict: false }).releaseDue();
    console.log(`inventory:daily — part requests: ${released.expired} reservations expired, ${released.closed} closed with their ticket`);
    const result = await app.get(StockRebuildService, { strict: false }).rebuild();
    const total = result.balances.length + result.valuations.length + result.reserved.length;
    console.log(`inventory:daily — stock rebuilt from the moves: ${total === 0 ? 'every balance matched' : `${total} differences fixed (see the audit log)`}`);
    for (const d of [...result.balances, ...result.valuations, ...result.reserved]) console.warn('inventory:daily — difference', JSON.stringify(d));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('inventory:daily failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
