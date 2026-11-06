import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { GeocodeResult, geocodingSettings, reverseGeocode } from '../../../platform/geocoding';
import { places } from '../schema';

/** After this many failed lookups a place is marked failed and no longer retried. */
export const MAX_ADDRESS_ATTEMPTS = 10;

export interface Place { id: number; address: string | null; latitude: number; longitude: number }

/**
 * Where punches were made. The address is looked up when the punch arrives (outside its transaction, so a slow provider
 * never holds a database lock); without a provider, or when the lookup fails, only the coordinates are stored and the
 * addresses:retry job tries again. Other modules use this through CoreFacade.
 */
@Injectable()
export class PlacesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  lookUp(latitude: number, longitude: number): Promise<GeocodeResult> {
    return reverseGeocode(latitude, longitude);
  }

  /** Stores the coordinates with what the lookup found (inside the caller's transaction). */
  async save(tx: Tx, p: { tenantId: number; latitude: number; longitude: number; accuracyM?: number | null }, found: GeocodeResult): Promise<Place> {
    const now = new Date();
    const resolved = found.status === 'found';
    const [row] = await tx.insert(places).values({
      tenantId: p.tenantId, latitude: String(p.latitude), longitude: String(p.longitude), accuracyM: p.accuracyM ?? null,
      address: resolved ? found.address : null, status: resolved ? 'resolved' : 'pending', provider: resolved ? found.provider : null,
      attempts: found.status === 'not_configured' ? 0 : 1, lastAttemptAt: found.status === 'not_configured' ? null : now, resolvedAt: resolved ? now : null,
    }).returning({ id: places.id });
    return { id: row.id, address: resolved ? found.address : null, latitude: p.latitude, longitude: p.longitude };
  }

  async get(conn: Conn, ids: number[]): Promise<Map<number, Place>> {
    if (ids.length === 0) return new Map();
    const rows = await conn.select({ id: places.id, address: places.address, latitude: places.latitude, longitude: places.longitude }).from(places)
      .where(inArray(places.id, ids));
    return new Map(rows.map((r) => [r.id, { id: r.id, address: r.address, latitude: Number(r.latitude), longitude: Number(r.longitude) }]));
  }

  /**
   * The background job: looks up pending addresses again (oldest first). Nothing happens while no provider is
   * configured. A place that fails MAX_ADDRESS_ATTEMPTS times is marked failed.
   */
  async retryPending(limit = 200): Promise<{ resolved: number; stillPending: number; gaveUp: number }> {
    const out = { resolved: 0, stillPending: 0, gaveUp: 0 };
    if (geocodingSettings().provider === 'none') return out;
    const pending = await this.db.select({ id: places.id, latitude: places.latitude, longitude: places.longitude, attempts: places.attempts })
      .from(places).where(and(eq(places.status, 'pending'), lt(places.attempts, MAX_ADDRESS_ATTEMPTS))).orderBy(asc(places.id)).limit(limit);
    for (const p of pending) {
      const found = await this.lookUp(Number(p.latitude), Number(p.longitude));
      const now = new Date();
      if (found.status === 'found') {
        await this.db.update(places).set({ address: found.address, status: 'resolved', provider: found.provider, attempts: p.attempts + 1,
          lastAttemptAt: now, resolvedAt: now }).where(eq(places.id, p.id));
        out.resolved++;
      } else if (found.status === 'failed') {
        const attempts = p.attempts + 1;
        await this.db.update(places).set({ attempts, lastAttemptAt: now, status: attempts >= MAX_ADDRESS_ATTEMPTS ? 'failed' : 'pending' }).where(eq(places.id, p.id));
        if (attempts >= MAX_ADDRESS_ATTEMPTS) out.gaveUp++; else out.stillPending++;
      } else {
        out.stillPending++;
      }
    }
    return out;
  }
}
