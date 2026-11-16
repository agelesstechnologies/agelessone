import { Inject, Injectable } from '@nestjs/common';
import { Tx } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { NewMove, StockRepository } from '../infrastructure/stock.repository';
import { applyChange, outgoingValue, unitCostOf, Valuation } from '../domain/valuation';
import { fromScaled } from '../domain/valuation';

/**
 * A quantity change to post. value: 'exact' (a known value, signed like qty: receipts, returns, reversals), 'average'
 * (stock leaving at the item's current average: issues, transfers out) or 'mirror' (stock arriving with the value another
 * planned move took: the transit side of a transfer).
 */
export interface PlannedMove {
  lineNo: number; itemId: number; locationId: number; qty: bigint;
  value: { kind: 'exact'; value: bigint } | { kind: 'average' } | { kind: 'mirror'; of: number };
  reversalOf?: number;
}

/** Codes for messages: item id → code, location id → code. */
export interface Labels { items: Map<number, string>; locations: Map<number, string> }

/**
 * Applies planned moves to the stock: locks the items' valuations and then the balances (always in that order, sorted, so
 * two posts never deadlock and two issues of the last unit cannot both pass), resolves each move's value, refuses
 * anything that would take a balance or the company's stock below zero, recalculates the moving average for the items in
 * `reprice`, and saves balances and valuations. Answers the moves with their values, ready to insert.
 */
@Injectable()
export class StockPosting {
  constructor(@Inject(StockRepository) private readonly repo: StockRepository) {}

  async apply(tx: Tx, tenantId: number, legalEntityId: number, planned: PlannedMove[], reprice: Set<number>, labels: Labels): Promise<NewMove[]> {
    const valuations = await this.repo.lockValuations(tx, tenantId, legalEntityId, planned.map((m) => m.itemId));
    const balances = await this.repo.lockBalances(tx, tenantId, legalEntityId, planned.map((m) => ({ itemId: m.itemId, locationId: m.locationId })));
    const state = new Map<number, Valuation>([...valuations].map(([itemId, v]) => [itemId, { ...v.v }]));
    const resolved: NewMove[] = [];

    for (const m of planned) {
      const v = state.get(m.itemId) as Valuation;
      let value: bigint;
      let unitCost: bigint;
      if (m.value.kind === 'average') {
        if (m.qty >= 0n) throw new Error('average value is for stock leaving');
        value = -outgoingValue(v, -m.qty);
        unitCost = v.avg;
      } else if (m.value.kind === 'mirror') {
        const other = resolved[m.value.of];
        value = -other.value;
        unitCost = other.unitCost;
      } else {
        value = m.value.value;
        unitCost = unitCostOf(value, m.qty);
      }
      const balance = balances.get(`${m.itemId}:${m.locationId}`) as { id: number; onHand: bigint; reserved: bigint };
      balance.onHand += m.qty;
      const next = applyChange(v, m.qty, value, false);
      if (balance.onHand < 0n || next === null) throw notEnough(m, balance.onHand - m.qty, labels);
      state.set(m.itemId, next);
      resolved.push({ lineNo: m.lineNo, itemId: m.itemId, locationId: m.locationId, qty: m.qty, value, unitCost, reversalOf: m.reversalOf ?? null });
    }

    for (const [itemId, v] of state) {
      const start = valuations.get(itemId) as { id: number; v: Valuation };
      const final = reprice.has(itemId) ? applyChange(start.v, v.qty - start.v.qty, v.value - start.v.value, true) : v;
      if (final === null || (final.qty === 0n && final.value !== 0n)) {
        throw new AppError('INVENTORY_REVERSAL_NOT_POSSIBLE', 409,
          `The stock of ${labels.items.get(itemId)} has moved since; this would leave value without stock. Post a correcting document instead`);
      }
      await this.repo.saveValuation(tx, start.id, final);
    }
    for (const b of balances.values()) await this.repo.saveBalance(tx, b.id, b.onHand);
    return resolved;
  }
}

function notEnough(m: PlannedMove, had: bigint, labels: Labels): AppError {
  const item = labels.items.get(m.itemId);
  const location = labels.locations.get(m.locationId);
  return new AppError('INVENTORY_NOT_ENOUGH_STOCK', 409,
    `Not enough ${item} in ${location}: ${fromScaled(had < 0n ? 0n : had, 4).replace(/\.?0+$/, '')} on hand, ${fromScaled(-m.qty, 4).replace(/\.?0+$/, '')} needed`,
    { item, location });
}
