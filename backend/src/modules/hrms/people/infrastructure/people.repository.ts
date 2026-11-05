import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, exists, ilike, inArray, isNull, like, ne, or, sql, SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { ListPeopleQuery, PersonDetail, PersonList, SharedContacts } from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { legalEntities, personContacts, persons } from '../../../core/schema';
import { departments, employments } from '../schema';
import { phoneSearchTerm } from '../domain/contacts';

export interface NewEmployment {
  tenantId: number; personId: number; legalEntityId: number; employeeCode: string; employmentType: string; status: 'active' | 'joining';
  recruitedOn?: string; joinedOn: string; isPrimary: boolean; managerPersonId: number | null; departmentId: number | null; designation?: string;
}
export type EmploymentPatch = { managerPersonId?: number | null; departmentId?: number | null; designation?: string | null };

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');
const dept = (code: string | null, name: string | null) => (code && name ? { code, name } : null);
const manager = alias(persons, 'manager');

/** Writes only hrms.* tables; reads core people and companies to answer questions about them. */
@Injectable()
export class PeopleRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findLegalEntityId(tx: Tx, tenantId: number, code: string): Promise<number | undefined> {
    const [row] = await tx.select({ id: legalEntities.id }).from(legalEntities)
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return row?.id;
  }

  /** A company's department by its code prefix; lock it while generating an employee code (one code at a time). */
  async findDepartment(tx: Tx, legalEntityId: number, codePrefix: string, lock = false) {
    const q = tx.select({ id: departments.id, codePrefix: departments.codePrefix }).from(departments)
      .where(and(eq(departments.legalEntityId, legalEntityId), eq(departments.codePrefix, codePrefix)));
    const [row] = lock ? await q.for('update') : await q;
    return row;
  }

  /** The company's employee codes starting with the prefix. */
  async codesWithPrefix(tx: Tx, legalEntityId: number, prefix: string): Promise<string[]> {
    const rows = await tx.select({ code: employments.employeeCode }).from(employments)
      .where(and(eq(employments.legalEntityId, legalEntityId), like(employments.employeeCode, `${prefix}%`)));
    return rows.map((r) => r.code);
  }

  async findPersonId(conn: Conn, tenantId: number, publicId: string): Promise<number | undefined> {
    const [row] = await conn.select({ id: persons.id }).from(persons)
      .where(and(eq(persons.tenantId, tenantId), eq(persons.publicId, publicId)));
    return row?.id;
  }

  /** True when the person has an active job whose manager is managerId (they are in that manager's team). */
  async managesPerson(conn: Conn, managerId: number, personId: number): Promise<boolean> {
    const [row] = await conn.select({ id: employments.id }).from(employments)
      .where(and(eq(employments.personId, personId), eq(employments.managerPersonId, managerId), eq(employments.status, 'active'))).limit(1);
    return row !== undefined;
  }

  async findContactPersonId(conn: Conn, tenantId: number, contactPublicId: string): Promise<number | undefined> {
    const [row] = await conn.select({ personId: personContacts.personId }).from(personContacts)
      .where(and(eq(personContacts.tenantId, tenantId), eq(personContacts.publicId, contactPublicId)));
    return row?.personId;
  }

  async clearPrimaryEmployment(tx: Tx, personId: number): Promise<void> {
    await tx.update(employments).set({ isPrimary: false }).where(and(eq(employments.personId, personId), eq(employments.isPrimary, true)));
  }

  /** Locks the employment and person rows so two changes to the same person's jobs can't interleave. */
  async findEmployment(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({ id: employments.id, personId: employments.personId, personPublicId: persons.publicId,
      legalEntityId: employments.legalEntityId, status: employments.status, isPrimary: employments.isPrimary, joinedOn: employments.joinedOn,
      offerLetterPath: employments.offerLetterPath, offerLetterType: employments.offerLetterType })
      .from(employments).innerJoin(persons, eq(persons.id, employments.personId))
      .where(and(eq(employments.tenantId, tenantId), eq(employments.publicId, publicId))).for('update');
    return row;
  }

  async updateEmployment(tx: Tx, id: number, patch: EmploymentPatch) {
    if (Object.keys(patch).length) await tx.update(employments).set(patch).where(eq(employments.id, id));
  }

  async activate(tx: Tx, id: number): Promise<void> {
    await tx.update(employments).set({ status: 'active' }).where(eq(employments.id, id));
  }

  async setOfferLetter(tx: Tx, id: number, path: string, type: string): Promise<void> {
    await tx.update(employments).set({ offerLetterPath: path, offerLetterType: type }).where(eq(employments.id, id));
  }

  /** Clears the person's other primary first, then marks this one (the database allows one active primary per person). */
  async makePrimary(tx: Tx, personId: number, employmentId: number): Promise<void> {
    await tx.update(employments).set({ isPrimary: false })
      .where(and(eq(employments.personId, personId), eq(employments.isPrimary, true), ne(employments.id, employmentId)));
    await tx.update(employments).set({ isPrimary: true }).where(eq(employments.id, employmentId));
  }

  async otherActiveEmployments(tx: Tx, personId: number, exceptId: number) {
    return tx.select({ id: employments.id, joinedOn: employments.joinedOn }).from(employments)
      .where(and(eq(employments.personId, personId), eq(employments.status, 'active'), ne(employments.id, exceptId)));
  }

  /** Exit keeps the row as history. It stays primary only when no other active employment takes over. */
  async exitEmployment(tx: Tx, id: number, exitOn: string, exitReason: string, stillPrimary: boolean): Promise<void> {
    await tx.update(employments).set({ status: 'exited', exitOn, exitReason, isPrimary: stillPrimary }).where(eq(employments.id, id));
  }

  /** Everyone in the tenant currently using exactly this (stored-form) contact value. */
  async sharedContacts(tenantId: number, value: string): Promise<SharedContacts['people']> {
    const rows = await this.db.select({
      publicId: persons.publicId, displayName: persons.displayName, status: persons.status,
      contactPublicId: personContacts.publicId, kind: personContacts.kind, label: personContacts.label, isPrimary: personContacts.isPrimary,
    }).from(personContacts).innerJoin(persons, eq(persons.id, personContacts.personId))
      .where(and(eq(personContacts.tenantId, tenantId), eq(personContacts.value, value), isNull(personContacts.endedAt)))
      .orderBy(asc(persons.displayName), asc(persons.id));
    return rows.map(({ contactPublicId, kind, label, isPrimary, ...p }) => ({ ...p, contact: { publicId: contactPublicId, kind, label, isPrimary } }));
  }

  /** Turns the database's uniqueness rules into the HRMS error codes. */
  async insertEmployment(tx: Tx, e: NewEmployment): Promise<string> {
    try {
      const [row] = await tx.insert(employments).values(e).returning({ publicId: employments.publicId });
      return row.publicId;
    } catch (err) {
      const constraint = violatedConstraint(err);
      if (constraint === 'uq_active_employment_per_company') {
        throw new AppError('HRMS_DUPLICATE_EMPLOYMENT', 409, 'This person already has an active employment in this company');
      }
      if (constraint === 'employments_company_code_unique') {
        throw new AppError('HRMS_DUPLICATE_EMPLOYEE_CODE', 409, `Employee code ${e.employeeCode} is already used in this company`);
      }
      throw err;
    }
  }

  /** visibleTo limits the list for callers without scope all: just themselves (own), or themselves and their team (team). */
  async list(tenantId: number, q: ListPeopleQuery, visibleTo?: { scope: 'own' | 'team'; personId: number }): Promise<PersonList> {
    const employmentFilter: SQL[] = [eq(employments.personId, persons.id)];
    if (q.company) employmentFilter.push(eq(legalEntities.code, q.company));
    if (q.status) employmentFilter.push(eq(employments.status, q.status));
    const where: (SQL | undefined)[] = [
      eq(persons.tenantId, tenantId),
      exists(this.db.select({ one: sql`1` }).from(employments)
        .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId)).where(and(...employmentFilter))),
    ];
    if (visibleTo?.scope === 'own') where.push(eq(persons.id, visibleTo.personId));
    if (visibleTo?.scope === 'team') {
      where.push(or(eq(persons.id, visibleTo.personId), exists(this.db.select({ one: sql`1` }).from(employments)
        .where(and(eq(employments.personId, persons.id), eq(employments.managerPersonId, visibleTo.personId), eq(employments.status, 'active'))))));
    }
    if (q.search) {
      const like = `%${escapeLike(q.search)}%`;
      const phone = phoneSearchTerm(q.search);
      where.push(or(
        ilike(persons.displayName, like),
        exists(this.db.select({ one: sql`1` }).from(employments)
          .where(and(eq(employments.personId, persons.id), ilike(employments.employeeCode, like)))),
        exists(this.db.select({ one: sql`1` }).from(personContacts)
          .where(and(eq(personContacts.personId, persons.id), isNull(personContacts.endedAt),
            ilike(personContacts.value, phone ? `%${escapeLike(phone)}%` : like)))),
      ));
    }

    const [{ total }] = await this.db.select({ total: count() }).from(persons).where(and(...where));
    const page = await this.db.select({ id: persons.id, publicId: persons.publicId, displayName: persons.displayName, status: persons.status })
      .from(persons).where(and(...where)).orderBy(asc(persons.displayName), asc(persons.id))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const primary = page.length === 0 ? [] : await this.db
      .select({ personId: employments.personId, company: legalEntities.code, employeeCode: employments.employeeCode,
        departmentCode: departments.codePrefix, departmentName: departments.name, designation: employments.designation, status: employments.status })
      .from(employments).innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .leftJoin(departments, eq(departments.id, employments.departmentId))
      .where(and(inArray(employments.personId, page.map((p) => p.id)), eq(employments.isPrimary, true)));

    return {
      items: page.map(({ id, ...p }) => {
        const e = primary.find((x) => x.personId === id);
        return { ...p, primaryEmployment: e ? { company: e.company, employeeCode: e.employeeCode, department: dept(e.departmentCode, e.departmentName),
          designation: e.designation, status: e.status } : null };
      }),
      page: q.page, pageSize: q.pageSize, total,
    };
  }

  async getDetail(tenantId: number, publicId: string): Promise<Omit<PersonDetail, 'private'> | undefined> {
    const [person] = await this.db.select({ id: persons.id, publicId: persons.publicId, displayName: persons.displayName, status: persons.status })
      .from(persons).where(and(eq(persons.tenantId, tenantId), eq(persons.publicId, publicId)));
    if (!person) return undefined;

    const contacts = await this.db.select({ publicId: personContacts.publicId, kind: personContacts.kind, value: personContacts.value,
      label: personContacts.label, isPrimary: personContacts.isPrimary, endedAt: personContacts.endedAt })
      .from(personContacts).where(eq(personContacts.personId, person.id))
      .orderBy(sql`${personContacts.endedAt} IS NOT NULL`, desc(personContacts.isPrimary), asc(personContacts.createdAt));

    const jobs = await this.db.select({
      publicId: employments.publicId, companyCode: legalEntities.code, companyName: legalEntities.name,
      employeeCode: employments.employeeCode, engagementType: employments.employmentType, status: employments.status,
      isPrimary: employments.isPrimary, recruitedOn: employments.recruitedOn, joinedOn: employments.joinedOn, exitOn: employments.exitOn,
      exitReason: employments.exitReason, departmentCode: departments.codePrefix, departmentName: departments.name, designation: employments.designation,
      managerPublicId: manager.publicId, managerName: manager.displayName, offerLetterPath: employments.offerLetterPath,
    }).from(employments)
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .leftJoin(departments, eq(departments.id, employments.departmentId))
      .leftJoin(manager, eq(manager.id, employments.managerPersonId))
      .where(eq(employments.personId, person.id))
      .orderBy(desc(employments.isPrimary), desc(employments.joinedOn));

    return {
      publicId: person.publicId, displayName: person.displayName, status: person.status,
      contacts: contacts.map((c) => ({ ...c, endedAt: c.endedAt?.toISOString() ?? null })),
      employments: jobs.map(({ companyCode, companyName, managerPublicId, managerName, departmentCode, departmentName, offerLetterPath, ...j }) => ({
        ...j, company: { code: companyCode, name: companyName }, department: dept(departmentCode, departmentName), hasOfferLetter: offerLetterPath !== null,
        manager: managerPublicId && managerName ? { publicId: managerPublicId, displayName: managerName } : null,
      })),
    };
  }
}
