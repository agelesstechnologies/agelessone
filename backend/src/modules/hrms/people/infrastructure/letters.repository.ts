import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { IssuedLetter, LetterKind } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { departments, employments, issuedLetters, letterTemplates } from '../schema';

const manager = alias(persons, 'manager');
const issuer = alias(persons, 'issuer');
const editor = alias(persons, 'editor');

/** Writes only hrms.letter_templates and hrms.issued_letters; reads companies, jobs and people. */
@Injectable()
export class LettersRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findCompany(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: legalEntities.id, code: legalEntities.code, name: legalEntities.name }).from(legalEntities)
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return row;
  }

  async template(legalEntityId: number, kind: LetterKind) {
    const [row] = await this.db.select({
      title: letterTemplates.title, body: letterTemplates.body, updatedAt: letterTemplates.updatedAt,
      editorPublicId: editor.publicId, editorName: editor.displayName,
    }).from(letterTemplates).innerJoin(editor, eq(editor.id, letterTemplates.updatedBy))
      .where(and(eq(letterTemplates.legalEntityId, legalEntityId), eq(letterTemplates.kind, kind)));
    return row;
  }

  async saveTemplate(tx: Tx, v: { tenantId: number; legalEntityId: number; kind: LetterKind; title: string; body: string; updatedBy: number }) {
    await tx.insert(letterTemplates).values(v).onConflictDoUpdate({
      target: [letterTemplates.legalEntityId, letterTemplates.kind],
      set: { title: v.title, body: v.body, updatedBy: v.updatedBy, updatedAt: new Date() },
    });
  }

  /** What a letter needs to know about one job. */
  async job(conn: Conn, tenantId: number, employmentPublicId: string) {
    const [row] = await conn.select({
      id: employments.id, publicId: employments.publicId, legalEntityId: employments.legalEntityId, employeeCode: employments.employeeCode,
      employmentType: employments.employmentType, joinedOn: employments.joinedOn, designation: employments.designation,
      personId: persons.id, personPublicId: persons.publicId, displayName: persons.displayName, fullName: persons.fullName,
      companyCode: legalEntities.code, companyName: legalEntities.name, department: departments.name, managerName: manager.displayName,
    }).from(employments)
      .innerJoin(persons, eq(persons.id, employments.personId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .leftJoin(departments, eq(departments.id, employments.departmentId))
      .leftJoin(manager, eq(manager.id, employments.managerPersonId))
      .where(and(eq(employments.tenantId, tenantId), eq(employments.publicId, employmentPublicId)));
    return row;
  }

  /** By public id across tenants: a public id is unique everywhere, so a resend can be recognised. */
  async issuedTenant(publicId: string): Promise<number | undefined> {
    const [row] = await this.db.select({ tenantId: issuedLetters.tenantId }).from(issuedLetters).where(eq(issuedLetters.publicId, publicId));
    return row?.tenantId;
  }

  async insertIssued(tx: Tx, v: { tenantId: number; publicId: string; legalEntityId: number; employmentId: number; personId: number;
    kind: LetterKind; title: string; body: string; issuedBy: number }) {
    await tx.insert(issuedLetters).values(v);
  }

  async issued(tenantId: number, publicId: string): Promise<IssuedLetter | undefined> {
    const [row] = await this.view().where(and(eq(issuedLetters.tenantId, tenantId), eq(issuedLetters.publicId, publicId)));
    return row && toIssued(row);
  }

  async issuedForJob(tenantId: number, employmentId: number): Promise<IssuedLetter[]> {
    const rows = await this.view().where(and(eq(issuedLetters.tenantId, tenantId), eq(issuedLetters.employmentId, employmentId)))
      .orderBy(desc(issuedLetters.issuedAt));
    return rows.map(toIssued);
  }

  private view() {
    return this.db.select({
      publicId: issuedLetters.publicId, kind: issuedLetters.kind, title: issuedLetters.title, body: issuedLetters.body, issuedAt: issuedLetters.issuedAt,
      personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
      issuerPublicId: issuer.publicId, issuerName: issuer.displayName,
    }).from(issuedLetters)
      .innerJoin(persons, eq(persons.id, issuedLetters.personId))
      .innerJoin(employments, eq(employments.id, issuedLetters.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, issuedLetters.legalEntityId))
      .innerJoin(issuer, eq(issuer.id, issuedLetters.issuedBy))
      .$dynamic();
  }
}

type ViewRow = Awaited<ReturnType<ReturnType<LettersRepository['view']>['execute']>>[number];
function toIssued(r: ViewRow): IssuedLetter {
  return {
    publicId: r.publicId, kind: r.kind as LetterKind, title: r.title, body: r.body, issuedAt: r.issuedAt.toISOString(),
    person: { publicId: r.personPublicId, displayName: r.personName },
    employment: { publicId: r.employmentPublicId, company: r.company, employeeCode: r.employeeCode },
    issuedBy: { publicId: r.issuerPublicId, displayName: r.issuerName },
  };
}
