import { Inject, Injectable } from '@nestjs/common';
import { Tx } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { LockedBalance, NewMove, placeKey, StockRepository } from '../infrastructure/stock.repository';
import { applyChange, fromScaled, outgoingValue, unitCostOf, Valuation } from '../domain/valuation';

/**
 * A quantity change to post. value: 'exact' (a known value, signed like qty: receipts, returns, reversals), 'average'
 * (stock leaving at the item's current average: issues, transfers out) or 'mirror' (stock arriving with the value another
 * planned move took: the transit side of a transfer). consumesReserved: stock leaving that a part request had reserved
 * (an issue against the request); any other stock leaving may take only what is not reserved.
 */
export interface PlannedMove {
  lineNo: number; itemId: number; locationId: number; batchId?: number | null; serialNo?: string | null; qty: bigint;
  value: { kind: 'exact'; value: bigint } | { kind: 'average' } | { kind: 'mirror'; of: number };
  consumesReserved?: bigint;
  reversalOf?: number;
}

/** Codes for messages: item id → code, location id → code. */
export interface Labels { items: Map<number, string>; locations: Map<number, string> }

const qtyText = (q: bigint) => fromScaled(q < 0n ? 0n : q, 4).replace(/\.?0+$/, '') || '0';

/**
 * Applies planned moves to the stock: locks the items' valuations, then the balances, then the serial units (always in
 * that order, sorted, so two posts never deadlock and two issues of the last unit cannot both pass), resolves each move's
 * value, refuses anything that would take a balance below zero or below what is reserved in it, keeps every serial unit
 * in exactly one place, recalculates the moving average for the items in `reprice`, and saves. Answers the moves with
 * their values, ready to insert.
 */
@Injectable()
export class StockPosting {
  constructor(@Inject(StockRepository) private readonly repo: StockRepository) {}

  async apply(tx: Tx, tenantId: number, legalEntityId: number, planned: PlannedMove[], reprice: Set<number>, labels: Labels): Promise<NewMove[]> {
    const valuations = await this.repo.lockValuations(tx, tenantId, legalEntityId, planned.map((m) => m.itemId));
    const balances = await this.repo.lockBalances(tx, tenantId, legalEntityId,
      planned.map((m) => ({ itemId: m.itemId, locationId: m.locationId, batchId: m.batchId ?? null })));
    const serials = await this.serials(tx, tenantId, legalEntityId, planned, labels);
    const state = new Map<number, Valuation>([...valuations].map(([itemId, v]) => [itemId, { ...v.v }]));
    const resolved: NewMove[] = [];

    for (const m of planned) {
      if (m.serialNo) serials.move(m);                  // where the unit is, before how many there are: the clearer refusal
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
      const b = balances.get(placeKey({ itemId: m.itemId, locationId: m.locationId, batchId: m.batchId ?? null })) as LockedBalance;
      const had = b.onHand;
      b.onHand += m.qty;
      b.reserved -= m.consumesReserved ?? 0n;
      const next = applyChange(v, m.qty, value, false);
      if (b.onHand < 0n || next === null) throw notEnough(m, had, labels);
      if (b.reserved < 0n) throw new Error(`reservation underflow at ${placeKey({ itemId: m.itemId, locationId: m.locationId, batchId: m.batchId ?? null })}`);
      if (m.qty < 0n && b.onHand < b.reserved) throw notAvailable(m, had - (b.reserved + (m.consumesReserved ?? 0n)), labels);
      state.set(m.itemId, next);
      resolved.push({ lineNo: m.lineNo, itemId: m.itemId, locationId: m.locationId, batchId: m.batchId ?? null, serialNo: m.serialNo ?? null,
        qty: m.qty, value, unitCost, reversalOf: m.reversalOf ?? null });
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
    for (const b of balances.values()) await this.repo.saveBalance(tx, b.id, b);
    await serials.save();
    return resolved;
  }

  /**
   * The serial units the moves touch, locked: move(m) checks and records one move (a unit arriving must not be in stock
   * anywhere; a unit leaving must be where it leaves from), save() stores where each unit ends up.
   */
  private async serials(tx: Tx, tenantId: number, legalEntityId: number, planned: PlannedMove[], labels: Labels) {
    const moves = planned.filter((m) => m.serialNo);
    if (moves.length === 0) return { move: (_m: PlannedMove) => undefined, save: async () => undefined };
    const serials = await this.repo.lockSerials(tx, tenantId, legalEntityId, moves.map((m) => ({ itemId: m.itemId, serialNo: m.serialNo as string })),
      moves.some((m) => m.qty > 0n));
    const where = new Map([...serials].map(([k, s]) => [k, s.locationId]));
    const elsewhere = await this.repo.locationsById(tx, [...where.values()].filter((l): l is number => l !== null));
    const name = (id: number | null) => (id === null ? 'not in stock' : `in ${labels.locations.get(id) ?? elsewhere.get(id)?.code ?? 'another location'}`);
    return {
      move: (m: PlannedMove) => {
        const k = `${m.itemId}:${m.serialNo}`;
        const at = where.has(k) ? where.get(k) as number | null : null;
        const label = `${m.serialNo} of ${labels.items.get(m.itemId)}`;
        if (m.qty > 0n) {
          if (at !== null) throw new AppError('INVENTORY_SERIAL_IN_STOCK', 409, `${label} is already ${name(at)}: a serial unit is in one place at a time`);
          where.set(k, m.locationId);
        } else {
          if (at !== m.locationId) throw new AppError('INVENTORY_SERIAL_NOT_HERE', 409, `${label} is ${name(at)}, not in ${labels.locations.get(m.locationId)}`);
          where.set(k, null);
        }
      },
      save: async () => {
        for (const [k, s] of serials) if (where.get(k) !== s.locationId) await this.repo.saveSerial(tx, s.id, where.get(k) ?? null);
      },
    };
  }
}

function notEnough(m: PlannedMove, had: bigint, labels: Labels): AppError {
  const item = labels.items.get(m.itemId);
  const location = labels.locations.get(m.locationId);
  return new AppError('INVENTORY_NOT_ENOUGH_STOCK', 409, `Not enough ${item} in ${location}: ${qtyText(had)} on hand, ${qtyText(-m.qty)} needed`, { item, location });
}

function notAvailable(m: PlannedMove, free: bigint, labels: Labels): AppError {
  const item = labels.items.get(m.itemId);
  const location = labels.locations.get(m.locationId);
  return new AppError('INVENTORY_NOT_ENOUGH_AVAILABLE', 409,
    `Only ${qtyText(free)} of ${item} in ${location} is free: the rest is reserved for part requests (${qtyText(-m.qty)} needed)`, { item, location });
}
