import { sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { Escalation } from '@ageless/shared';

/** Select fields for a request table's escalation columns, with the forwarder's public id and name looked up. */
export function escalationFields(t: { escalatedAt: PgColumn; escalatedBy: PgColumn; escalationReason: PgColumn }) {
  return {
    escalatedAt: sql<Date | null>`${t.escalatedAt}`.mapWith((v: unknown): Date | null => (v === null ? null : new Date(v as string))),
    escalationReason: sql<string | null>`${t.escalationReason}`,
    escalatedByPublicId: sql<string | null>`(SELECT p.public_id::text FROM core.persons p WHERE p.id = ${t.escalatedBy})`,
    escalatedByName: sql<string | null>`(SELECT p.display_name FROM core.persons p WHERE p.id = ${t.escalatedBy})`,
  };
}

/** The escalation columns of a request as selected by a repository (the forwarder's public id and name looked up). */
export interface EscalationRow {
  escalatedAt: Date | null; escalationReason: string | null; escalatedByPublicId: string | null; escalatedByName: string | null;
}

/** null when the request was never sent to the CEO; `by` null when it went automatically (waited too long). */
export function toEscalation(r: EscalationRow): Escalation | null {
  if (!r.escalatedAt) return null;
  return {
    at: r.escalatedAt.toISOString(), reason: r.escalationReason ?? '',
    by: r.escalatedByPublicId && r.escalatedByName ? { publicId: r.escalatedByPublicId, displayName: r.escalatedByName } : null,
  };
}

/** The reason written when a request is escalated automatically. */
export const waitedTooLong = (days: number) => `No decision in ${days} day${days === 1 ? '' : 's'}`;
