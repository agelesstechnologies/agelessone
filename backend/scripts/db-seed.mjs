// Fills YOUR development database (from DATABASE_URL) with fictional starter data. Safe to run again:
// rows that already exist are left alone. Run `pnpm db:migrate` first.
import 'dotenv/config';
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL ?? '');
const dbName = url.pathname.slice(1);
if (!dbName || /prod|staging/i.test(dbName) || !/^(dev_|ageless_dev|ageless_test|platform_test)/.test(dbName)) {
  console.error(`Refusing to seed "${dbName}". Only development databases (dev_*, ageless_dev, ageless_test) can be seeded.`);
  process.exit(1);
}

// Fixed public ids, so the same people exist on every PC (handy for x-person-id while login is TEMP).
const people = [
  { publicId: '00000000-0000-4000-8000-000000000001', employmentId: '00000000-0000-4000-8000-000000000101', display: 'Demo Supervisor', full: 'Demo Supervisor One', company: 'AE', code: 'AE-D001' },
  { publicId: '00000000-0000-4000-8000-000000000002', employmentId: '00000000-0000-4000-8000-000000000102', display: 'Demo Technician', full: 'Demo Technician Two', company: 'AE', code: 'AE-D002' },
  { publicId: '00000000-0000-4000-8000-000000000003', employmentId: '00000000-0000-4000-8000-000000000103', display: 'Demo Engineer', full: 'Demo Engineer Three', company: 'ATPL', code: 'ATPL-D001' },
];

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`INSERT INTO core.tenants (id, name) OVERRIDING SYSTEM VALUE VALUES (1, 'Ageless (development)') ON CONFLICT (id) DO NOTHING`);
  await client.query(`SELECT setval(pg_get_serial_sequence('core.tenants', 'id'), (SELECT max(id) FROM core.tenants))`);
  await client.query(`
    INSERT INTO core.legal_entities (tenant_id, code, name, legal_form) VALUES
      (1, 'AE', 'Ageless Entertainments', 'other'),
      (1, 'ATPL', 'Ageless Technologies', 'private_limited')
    ON CONFLICT (tenant_id, code) DO NOTHING`);
  for (const p of people) {
    await client.query(
      `INSERT INTO core.persons (tenant_id, public_id, person_type, display_name, full_name)
       VALUES (1, $1, 'employee', $2, $3) ON CONFLICT (public_id) DO NOTHING`,
      [p.publicId, p.display, p.full]);
    await client.query(
      `INSERT INTO hrms.employments (tenant_id, public_id, person_id, legal_entity_id, employee_code, employment_type, joined_on, is_primary)
       SELECT 1, $1, p.id, le.id, $2, 'permanent', DATE '2025-04-01', true
         FROM core.persons p JOIN core.legal_entities le ON le.tenant_id = 1 AND le.code = $4
        WHERE p.public_id = $3
       ON CONFLICT (public_id) DO NOTHING`,
      [p.employmentId, p.code, p.publicId, p.company]);
  }
  await client.query('COMMIT');
  const { rows } = await client.query(`SELECT
    (SELECT count(*) FROM core.tenants) AS tenants, (SELECT count(*) FROM core.legal_entities) AS legal_entities,
    (SELECT count(*) FROM core.persons) AS persons, (SELECT count(*) FROM hrms.employments) AS employments`);
  console.log(`Seeded "${dbName}":`, rows[0]);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
