import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { Conn, DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { bankAccounts } from '../../../payroll/schema';
import { employments, personPrivate } from '../schema';

/** Writes only hrms.person_private; reads salary bank accounts (payroll.bank_accounts) to show them masked. */
@Injectable()
export class PrivateRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findPerson(conn: Conn, tenantId: number, publicId: string) {
    const [row] = await conn.select({ id: persons.id, displayName: persons.displayName })
      .from(persons).where(and(eq(persons.tenantId, tenantId), eq(persons.publicId, publicId)));
    return row;
  }

  async ids(conn: Conn, personId: number) {
    const [row] = await conn.select({ aadhaar: personPrivate.aadhaar, pan: personPrivate.pan })
      .from(personPrivate).where(eq(personPrivate.personId, personId));
    return row ?? { aadhaar: null, pan: null };
  }

  /** Every salary bank account on the person's jobs, newest first. */
  async bankAccounts(conn: Conn, tenantId: number, personId: number) {
    return conn.select({
      publicId: bankAccounts.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
      accountHolder: bankAccounts.accountHolder, accountNumber: bankAccounts.accountNumber, ifsc: bankAccounts.ifsc,
      effectiveFrom: bankAccounts.effectiveFrom,
    }).from(bankAccounts)
      .innerJoin(employments, eq(employments.id, bankAccounts.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, bankAccounts.legalEntityId))
      .where(and(eq(bankAccounts.tenantId, tenantId), eq(employments.personId, personId)))
      .orderBy(desc(bankAccounts.effectiveFrom), desc(bankAccounts.id));
  }

  /** Only the fields given change (undefined: unchanged; null: cleared). */
  async upsert(tx: Tx, tenantId: number, personId: number, patch: { aadhaar?: string | null; pan?: string | null }, by: number): Promise<void> {
    await tx.insert(personPrivate).values({ personId, tenantId, aadhaar: patch.aadhaar ?? null, pan: patch.pan ?? null, updatedBy: by })
      .onConflictDoUpdate({ target: personPrivate.personId, set: { ...patch, updatedBy: by, updatedAt: new Date() } });
  }
}
