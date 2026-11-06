import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, between, eq, inArray, lt, ne, or, sql, SQL } from 'drizzle-orm';
import { Certificate, CertificateStatus, PersonSkill, Skill, SkillLevel } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { departments, employments } from '../../people/schema';
import { certificates, personSkills, skills } from '../schema';

/** Who the caller may see: everyone, their team (and themselves), or only themselves. */
export type Visibility = { scope: 'all' } | { scope: 'team' | 'own'; personId: number };

const verifier = aliasedTable(persons, 'verifier');
const holder = aliasedTable(persons, 'holder');

/** Writes only hrms.skills, hrms.person_skills and hrms.certificates; reads people, jobs, departments and companies. */
@Injectable()
export class SkillsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findCompany(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: legalEntities.id }).from(legalEntities).where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return row;
  }

  async findDepartment(legalEntityId: number, codePrefix: string) {
    const [row] = await this.db.select({ id: departments.id }).from(departments)
      .where(and(eq(departments.legalEntityId, legalEntityId), eq(departments.codePrefix, codePrefix)));
    return row;
  }

  async findPersonId(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: persons.id }).from(persons).where(and(eq(persons.tenantId, tenantId), eq(persons.publicId, publicId)));
    return row?.id;
  }

  /** The person has a current (joining or active) job managed by managerId. */
  async manages(managerId: number, personId: number): Promise<boolean> {
    const [row] = await this.db.select({ id: employments.id }).from(employments)
      .where(and(eq(employments.personId, personId), eq(employments.managerPersonId, managerId),
        inArray(employments.status, ['joining', 'active']))).limit(1);
    return row !== undefined;
  }

  // ---- skills list ----

  async skills(tenantId: number, company?: string, department?: string): Promise<Skill[]> {
    const rows = await this.db.select({
      publicId: skills.publicId, company: legalEntities.code, departmentCode: departments.codePrefix, departmentName: departments.name,
      code: skills.code, name: skills.name,
    }).from(skills).innerJoin(legalEntities, eq(legalEntities.id, skills.legalEntityId)).leftJoin(departments, eq(departments.id, skills.departmentId))
      .where(and(eq(skills.tenantId, tenantId), company ? eq(legalEntities.code, company) : undefined, department ? eq(departments.codePrefix, department) : undefined))
      .orderBy(asc(legalEntities.code), sql`${departments.name} NULLS LAST`, asc(skills.name));
    return rows.map(({ departmentCode, departmentName, ...s }) => ({ ...s, department: departmentCode ? { code: departmentCode, name: departmentName! } : null }));
  }

  async insertSkill(v: { tenantId: number; legalEntityId: number; departmentId: number | null; code: string; name: string }): Promise<string> {
    const [row] = await this.db.insert(skills).values(v).returning({ publicId: skills.publicId });
    return row.publicId;
  }

  async findSkill(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: skills.id }).from(skills).where(and(eq(skills.tenantId, tenantId), eq(skills.publicId, publicId)));
    return row;
  }

  // ---- person skills ----

  /** Adds the skill, or changes its level; a changed level clears the verification. */
  async upsertPersonSkill(v: { tenantId: number; personId: number; skillId: number; level: SkillLevel }): Promise<string> {
    const [row] = await this.db.insert(personSkills).values(v)
      .onConflictDoUpdate({
        target: [personSkills.personId, personSkills.skillId],
        set: {
          level: v.level,
          verifiedBy: sql`CASE WHEN ${personSkills.level} = excluded.level THEN ${personSkills.verifiedBy} END`,
          verifiedAt: sql`CASE WHEN ${personSkills.level} = excluded.level THEN ${personSkills.verifiedAt} END`,
        },
      }).returning({ publicId: personSkills.publicId });
    return row.publicId;
  }

  async lockPersonSkill(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({ id: personSkills.id, personId: personSkills.personId }).from(personSkills)
      .where(and(eq(personSkills.tenantId, tenantId), eq(personSkills.publicId, publicId))).for('update');
    return row;
  }

  async verifyPersonSkill(tx: Tx, id: number, by: number): Promise<void> {
    await tx.update(personSkills).set({ verifiedBy: by, verifiedAt: new Date() }).where(eq(personSkills.id, id));
  }

  async personSkill(tenantId: number, publicId: string): Promise<PersonSkill | undefined> {
    const [row] = await this.personSkills(eq(personSkills.publicId, publicId), tenantId);
    return row;
  }

  async skillsOf(tenantId: number, personIds: number[]): Promise<(PersonSkill & { personId: number })[]> {
    if (personIds.length === 0) return [];
    return this.personSkills(inArray(personSkills.personId, personIds), tenantId);
  }

  // ---- certificates ----

  async insertCertificate(v: { tenantId: number; personId: number; name: string; issuer?: string; number?: string; issuedOn?: string;
    expiresOn?: string; filePath: string | null; fileType: string | null; status: CertificateStatus }): Promise<string> {
    const [row] = await this.db.insert(certificates).values(v).returning({ publicId: certificates.publicId });
    return row.publicId;
  }

  async lockCertificate(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({ id: certificates.id, personId: certificates.personId, status: certificates.status, expiresOn: certificates.expiresOn,
      filePath: certificates.filePath, fileType: certificates.fileType })
      .from(certificates).where(and(eq(certificates.tenantId, tenantId), eq(certificates.publicId, publicId))).for('update');
    return row;
  }

  async verifyCertificate(tx: Tx, id: number, by: number): Promise<void> {
    await tx.update(certificates).set({ status: 'verified', verifiedBy: by, verifiedAt: new Date() }).where(eq(certificates.id, id));
  }

  async certificate(tenantId: number, publicId: string): Promise<Certificate | undefined> {
    const [row] = await this.certificateView(and(eq(certificates.tenantId, tenantId), eq(certificates.publicId, publicId))!);
    return row;
  }

  async certificatesOf(tenantId: number, personIds: number[]): Promise<(Certificate & { personId: number })[]> {
    if (personIds.length === 0) return [];
    return this.certificateView(and(eq(certificates.tenantId, tenantId), inArray(certificates.personId, personIds))!);
  }

  /** Still valid (not marked expired, not past their date) and expiring between from and to. */
  async expiring(tenantId: number, from: string, to: string) {
    return this.certificateView(and(eq(certificates.tenantId, tenantId), ne(certificates.status, 'expired'), between(certificates.expiresOn, from, to))!);
  }

  /** The daily job: every tenant's certificates past their date become expired. Returns how many changed. */
  async markExpired(conn: Conn, today: string): Promise<number> {
    const rows = await conn.update(certificates).set({ status: 'expired' })
      .where(and(lt(certificates.expiresOn, today), ne(certificates.status, 'expired'))).returning({ id: certificates.id });
    return rows.length;
  }

  async countExpiring(from: string, to: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(certificates)
      .where(and(ne(certificates.status, 'expired'), between(certificates.expiresOn, from, to)));
    return row.n;
  }

  // ---- matrix ----

  /** Current (joining or active) jobs visible to the caller, optionally one company / department. */
  async jobs(tenantId: number, company: string | undefined, department: string | undefined, visibleTo: Visibility) {
    return this.db.select({
      personId: employments.personId, personPublicId: holder.publicId, personName: holder.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
      departmentCode: departments.codePrefix, departmentName: departments.name,
    }).from(employments)
      .innerJoin(holder, eq(holder.id, employments.personId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .leftJoin(departments, eq(departments.id, employments.departmentId))
      .where(and(eq(employments.tenantId, tenantId), inArray(employments.status, ['joining', 'active']),
        company ? eq(legalEntities.code, company) : undefined, department ? eq(departments.codePrefix, department) : undefined,
        this.visible(visibleTo)))
      .orderBy(asc(legalEntities.code), asc(holder.displayName));
  }

  private visible(v: Visibility): SQL | undefined {
    if (v.scope === 'all') return undefined;
    if (v.scope === 'own') return eq(employments.personId, v.personId);
    return or(eq(employments.personId, v.personId), eq(employments.managerPersonId, v.personId));
  }

  private async personSkills(where: SQL, tenantId: number) {
    const rows = await this.db.select({
      personId: personSkills.personId, publicId: personSkills.publicId, skillPublicId: skills.publicId, code: skills.code, name: skills.name,
      level: personSkills.level, verifierPublicId: verifier.publicId, verifierName: verifier.displayName, verifiedAt: personSkills.verifiedAt,
    }).from(personSkills).innerJoin(skills, eq(skills.id, personSkills.skillId)).leftJoin(verifier, eq(verifier.id, personSkills.verifiedBy))
      .where(and(eq(personSkills.tenantId, tenantId), where)).orderBy(asc(skills.name));
    return rows.map((r) => ({
      personId: r.personId, publicId: r.publicId, skill: { publicId: r.skillPublicId, code: r.code, name: r.name }, level: r.level as SkillLevel,
      verifiedBy: r.verifierPublicId ? { publicId: r.verifierPublicId, displayName: r.verifierName! } : null, verifiedAt: r.verifiedAt?.toISOString() ?? null,
    }));
  }

  private async certificateView(where: SQL) {
    const rows: CertificateRow[] = await this.db.select({
      personId: certificates.personId, publicId: certificates.publicId, holderPublicId: holder.publicId, holderName: holder.displayName,
      name: certificates.name, issuer: certificates.issuer, number: certificates.number, issuedOn: certificates.issuedOn,
      expiresOn: certificates.expiresOn, status: certificates.status, filePath: certificates.filePath,
      verifierPublicId: verifier.publicId, verifierName: verifier.displayName, verifiedAt: certificates.verifiedAt, createdAt: certificates.createdAt,
    }).from(certificates).innerJoin(holder, eq(holder.id, certificates.personId)).leftJoin(verifier, eq(verifier.id, certificates.verifiedBy))
      .where(where).orderBy(sql`${certificates.expiresOn} NULLS LAST`, asc(certificates.name));
    return rows.map((r) => ({
      personId: r.personId, publicId: r.publicId, person: { publicId: r.holderPublicId, displayName: r.holderName },
      name: r.name, issuer: r.issuer, number: r.number, issuedOn: r.issuedOn, expiresOn: r.expiresOn, status: r.status as CertificateStatus,
      hasFile: r.filePath !== null, verifiedBy: r.verifierPublicId ? { publicId: r.verifierPublicId, displayName: r.verifierName! } : null,
      verifiedAt: r.verifiedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
    }));
  }
}

interface CertificateRow {
  personId: number; publicId: string; holderPublicId: string; holderName: string; name: string; issuer: string | null; number: string | null;
  issuedOn: string | null; expiresOn: string | null; status: string; filePath: string | null; verifierPublicId: string | null;
  verifierName: string | null; verifiedAt: Date | null; createdAt: Date;
}
