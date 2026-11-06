import { Inject, Injectable } from '@nestjs/common';
import { Conn, DB, Db } from '../../../platform/db/db.module';
import { auditLog } from '../schema';

export interface AuditEntry {
  tenantId: number;
  actorPersonId: number | null;       // null: the system
  action: string;                     // e.g. leave.approved, private.revealed
  entity: string;                     // e.g. leave_request
  entityPublicId?: string;
  subjectPersonId?: number | null;    // whose record it is
  legalEntityId?: number | null;      // the company it belongs to
  /** Readable, for the dashboard's activity list. Never Aadhaar, PAN, bank or phone numbers. */
  summary: string;
  details?: Record<string, unknown>;
}

/** Writes the audit log (append-only). Other modules write through CoreFacade.audit, inside their own transaction. */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async write(conn: Conn, e: AuditEntry): Promise<void> {
    await conn.insert(auditLog).values({ ...e, details: e.details ?? null });
  }
}
