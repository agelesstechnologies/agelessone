import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/** Runs once before the tests: empties the test database, applies every migration, adds the seed data. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set. Copy it from apps/api/.env.example into apps/api/.env.');
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
}
