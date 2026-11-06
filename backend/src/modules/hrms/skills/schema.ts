import { sql } from 'drizzle-orm';
import { bigint, text, date, uuid, timestamp, unique, check, foreignKey, index } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { legalEntities, persons } from '../../core/schema';
import { departments } from '../people/schema';

/** A company's skills list, grouped by department (department optional). */
export const skills = hrms.table('skills', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  departmentId: bigint('department_id', { mode: 'number' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
}, (t) => [
  foreignKey({ name: 'skills_department_company_fk', columns: [t.departmentId, t.legalEntityId], foreignColumns: [departments.id, departments.legalEntityId] }),
  unique('skills_company_code_unique').on(t.legalEntityId, t.code),
  unique('skills_id_company_unique').on(t.id, t.legalEntityId), // target of company-safe foreign keys (tickets)
]);

/** A person's skill and level. Verified by someone else (never themselves). */
export const personSkills = hrms.table('person_skills', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  skillId: bigint('skill_id', { mode: 'number' }).notNull().references(() => skills.id),
  level: text('level').notNull(),
  verifiedBy: bigint('verified_by', { mode: 'number' }).references(() => persons.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('person_skills_person_skill_unique').on(t.personId, t.skillId),
  check('person_skills_level_check', sql`level IN ('trainee','skilled','expert')`),
  check('person_skills_not_self_verified', sql`verified_by IS NULL OR verified_by <> person_id`),
  check('person_skills_verified_together', sql`(verified_by IS NULL) = (verified_at IS NULL)`),
]);

/** A person's certificate (with its file). review → verified; expired once past expires_on (daily job). */
export const certificates = hrms.table('certificates', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  name: text('name').notNull(),
  issuer: text('issuer'),
  number: text('number'),                                   // the certificate's own number (never logged)
  issuedOn: date('issued_on'),
  expiresOn: date('expires_on'),
  filePath: text('file_path'),                              // relative to the uploads folder
  fileType: text('file_type'),                              // pdf, jpg or png
  status: text('status').notNull().default('review'),
  verifiedBy: bigint('verified_by', { mode: 'number' }).references(() => persons.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_certificates_expires').on(t.tenantId, t.expiresOn),
  check('certificates_status_check', sql`status IN ('review','verified','expired')`),
  check('certificates_dates_check', sql`issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on`),
  check('certificates_not_self_verified', sql`verified_by IS NULL OR verified_by <> person_id`),
]);
// Next: training_records
