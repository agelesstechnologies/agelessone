import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, Db } from '../../../platform/db/db.module';
import { CoreFacade } from '../../core/core.facade';
import { fromScaled, toScaled, unitCostOf } from '../domain/valuation';

export interface StockDifference {
  tenantId: number; legalEntityId: number; itemId: number; locationId: number | null;
  /** from the moves */
  expectedQty: string; storedQty: string; expectedValue?: string; storedValue?: string;
}
export interface RebuildResult { balances: StockDifference[]; valuations: StockDifference[] }

/**
 * The nightly check (inventory:daily): rebuilds every balance and valuation from the stock moves, fixes any that differ,
 * and alerts (an audit entry per company with the differences). Moves are the truth; a difference means something wrote
 * the balances outside posting. Posting waits while it runs (the two tables are locked for the rebuild).
 */
@Injectable()
export class StockRebuildService {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CoreFacade) private readonly core: CoreFacade) {}

  async rebuild(): Promise<RebuildResult> {
    return this.db.transaction(async (tx) => {
      // valuations first, then balances: the order posting locks them in
      await tx.execute(sql`LOCK TABLE inventory.stock_valuations, inventory.stock_balances IN EXCLUSIVE MODE`);

      const balances = (await tx.execute<{ id: string | null; tenant_id: string; legal_entity_id: string; item_id: string; location_id: string;
        batch_id: string | null; expected: string; stored: string }>(sql`
        WITH m AS (
          SELECT tenant_id, legal_entity_id, item_id, location_id, batch_id, sum(qty_delta) AS q
            FROM inventory.stock_moves GROUP BY tenant_id, legal_entity_id, item_id, location_id, batch_id)
        SELECT b.id, coalesce(m.tenant_id, b.tenant_id) AS tenant_id, coalesce(m.legal_entity_id, b.legal_entity_id) AS legal_entity_id,
               coalesce(m.item_id, b.item_id) AS item_id, coalesce(m.location_id, b.location_id) AS location_id, coalesce(m.batch_id, b.batch_id) AS batch_id,
               coalesce(m.q, 0)::text AS expected, coalesce(b.on_hand, 0)::text AS stored
          FROM m FULL OUTER JOIN inventory.stock_balances b
            ON b.legal_entity_id = m.legal_entity_id AND b.item_id = m.item_id AND b.location_id = m.location_id AND coalesce(b.batch_id, 0) = coalesce(m.batch_id, 0)
         WHERE coalesce(m.q, 0) <> coalesce(b.on_hand, 0)`)).rows;
      for (const d of balances) {
        if (d.id === null) {
          await tx.execute(sql`INSERT INTO inventory.stock_balances (tenant_id, legal_entity_id, item_id, location_id, batch_id, on_hand)
            VALUES (${d.tenant_id}, ${d.legal_entity_id}, ${d.item_id}, ${d.location_id}, ${d.batch_id}, ${d.expected})`);
        } else {
          await tx.execute(sql`UPDATE inventory.stock_balances SET on_hand = ${d.expected}::numeric, reserved = least(reserved, ${d.expected}::numeric), updated_at = now()
            WHERE id = ${d.id}`);
        }
      }

      const valuations = (await tx.execute<{ id: string | null; tenant_id: string; legal_entity_id: string; item_id: string; qty: string; value: string;
        stored_qty: string; stored_value: string; avg: string | null }>(sql`
        WITH m AS (
          SELECT tenant_id, legal_entity_id, item_id, sum(qty_delta) AS q, sum(value_delta_minor) AS v FROM inventory.stock_moves GROUP BY tenant_id, legal_entity_id, item_id)
        SELECT s.id, coalesce(m.tenant_id, s.tenant_id) AS tenant_id, coalesce(m.legal_entity_id, s.legal_entity_id) AS legal_entity_id,
               coalesce(m.item_id, s.item_id) AS item_id, coalesce(m.q, 0)::text AS qty, coalesce(m.v, 0)::text AS value,
               coalesce(s.on_hand, 0)::text AS stored_qty, coalesce(s.value_minor, 0)::text AS stored_value, s.avg_cost_minor::text AS avg
          FROM m FULL OUTER JOIN inventory.stock_valuations s ON s.item_id = m.item_id
         WHERE coalesce(m.q, 0) <> coalesce(s.on_hand, 0) OR coalesce(m.v, 0) <> coalesce(s.value_minor, 0)`)).rows;
      for (const d of valuations) {
        const qty = toScaled(d.qty, 4);
        const value = qty > 0n ? BigInt(d.value) : 0n;      // nothing in stock keeps no value (the alert shows what the moves said)
        const avg = qty > 0n ? unitCostOf(value, qty) : toScaled(d.avg ?? '0', 6);
        if (d.id === null) {
          await tx.execute(sql`INSERT INTO inventory.stock_valuations (tenant_id, legal_entity_id, item_id, on_hand, value_minor, avg_cost_minor)
            VALUES (${d.tenant_id}, ${d.legal_entity_id}, ${d.item_id}, ${d.qty}, ${value.toString()}, ${fromScaled(avg, 6)})`);
        } else {
          await tx.execute(sql`UPDATE inventory.stock_valuations SET on_hand = ${d.qty}::numeric, value_minor = ${value.toString()}::bigint,
            avg_cost_minor = ${fromScaled(avg, 6)}::numeric, updated_at = now() WHERE id = ${d.id}`);
        }
      }

      const result: RebuildResult = {
        balances: balances.map((d) => ({ tenantId: Number(d.tenant_id), legalEntityId: Number(d.legal_entity_id), itemId: Number(d.item_id),
          locationId: Number(d.location_id), expectedQty: d.expected, storedQty: d.stored })),
        valuations: valuations.map((d) => ({ tenantId: Number(d.tenant_id), legalEntityId: Number(d.legal_entity_id), itemId: Number(d.item_id), locationId: null,
          expectedQty: d.qty, storedQty: d.stored_qty, expectedValue: d.value, storedValue: d.stored_value })),
      };
      const byCompany = new Map<string, StockDifference[]>();
      for (const d of [...result.balances, ...result.valuations]) {
        const k = `${d.tenantId}:${d.legalEntityId}`;
        byCompany.set(k, [...(byCompany.get(k) ?? []), d]);
      }
      for (const [k, diffs] of byCompany) {
        const [tenantId, legalEntityId] = k.split(':').map(Number);
        await this.core.audit(tx, { tenantId, actorPersonId: null, action: 'inventory.stock.rebuilt', entity: 'inventory_stock', legalEntityId,
          summary: `Stock rebuilt from the moves: ${diffs.length} stored balance${diffs.length === 1 ? '' : 's'} differed and ${diffs.length === 1 ? 'was' : 'were'} fixed`,
          details: { differences: diffs.slice(0, 100) } });
      }
      return result;
    });
  }
}
