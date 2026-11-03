// Drops and recreates YOUR development database (from DATABASE_URL), then `db:migrate` rebuilds it.
// Refuses to run against anything that is not a local or office development database.
import 'dotenv/config';
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL ?? '');
const dbName = url.pathname.slice(1);
if (!dbName || /prod|staging/i.test(dbName) || !/^(dev_|ageless_dev|ageless_test|platform_test)/.test(dbName)) {
  console.error(`Refusing to reset "${dbName}". Only development databases (dev_*, ageless_dev, ageless_test) can be reset.`);
  process.exit(1);
}
const admin = new URL(url); admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
await client.query(`CREATE DATABASE "${dbName}"`);
await client.end();
console.log(`Recreated empty database "${dbName}". Running migrations next...`);
