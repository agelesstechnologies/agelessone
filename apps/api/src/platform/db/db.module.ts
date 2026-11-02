import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';

export const DB = Symbol('DB');
export type Db = NodePgDatabase;

/** One shared connection pool for the whole backend. Each request sets app.tenant_id inside its transaction. */
@Global()
@Module({
  providers: [{ provide: DB, useFactory: (): Db => drizzle(new Pool({ connectionString: process.env.DATABASE_URL })) }],
  exports: [DB],
})
export class DbModule {}
