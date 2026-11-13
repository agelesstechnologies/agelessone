import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/**/schema.ts',     // every module keeps its tables beside its code
  out: './drizzle',                          // one ordered list of migrations for the whole database
  schemaFilter: ['core', 'tickets', 'hrms', 'payroll', 'intercompany'], // add each new module's schema here when it starts
  dbCredentials: { url: process.env.DATABASE_URL! },
  migrations: { table: '__migrations', schema: 'public' },
});
