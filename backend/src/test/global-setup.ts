import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/** Runs once before the tests: empties the test database, applies every migration, adds the seed data. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set. Copy it from backend/.env.example into backend/.env.');
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point to a database whose name ends in _test.');

  const apiRoot = resolve(__dirname, '../..');
  execFileSync(process.execPath, ['scripts/db-reset.mjs'], { cwd: apiRoot, env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });

  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve(apiRoot, 'drizzle'), migrationsTable: '__migrations', migrationsSchema: 'public' });
  } finally {
    await pool.end();
  }
  execFileSync(process.execPath, ['scripts/db-seed.mjs'], { cwd: apiRoot, env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });

  // Test database only, written once before any test (the files share one database, so no test changes it):
  // POLICY hrms.people.one_company_per_person is off for jobs joining before 2030, so the tests of people who work for two
  // companies (as those hired before the rule, or with HR turning it off) keep running; it is on from 2030, where the
  // tests of the rule join their jobs. Approved by the seed's policy approver (Demo HR).
  const after = new Pool({ connectionString: url });
  try {
    await after.query(
      `INSERT INTO core.policies (tenant_id, public_id, legal_entity_id, policy_key, value, version, effective_from, approved_by)
       SELECT 1, gen_random_uuid(), NULL, 'hrms.people.one_company_per_person', v.value::jsonb, v.version, v.effective_from::date,
              (SELECT approved_by FROM core.policies WHERE policy_key = 'core.auth.session_hours' AND version = 1 LIMIT 1)
       FROM (VALUES ('false', 1, '2000-01-01'), ('true', 2, '2030-01-01')) AS v(value, version, effective_from)`);
  } finally {
    await after.end();
  }
}
