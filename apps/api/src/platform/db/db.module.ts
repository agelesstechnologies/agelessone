import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';

export const DB = Symbol('DB');
export type Db = NodePgDatabase;
/** The handle inside db.transaction(async (tx) => ...); pass it to every write of one use case. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The constraint a PostgreSQL error broke (pgCode 23505 = unique, 23514 = check); Drizzle wraps the pg error in `cause`. */
export function violatedConstraint(err: unknown, pgCode = '23505'): string | undefined {
  for (let e = err as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === pgCode && typeof e.constraint === 'string') return e.constraint;
  }
  return undefined;
}

/** One shared connection pool for the whole backend. Each request sets app.tenant_id inside its transaction. */
@Global()
@Module({
  providers: [{ provide: DB, useFactory: (): Db => drizzle(new Pool({ connectionString: process.env.DATABASE_URL })) }],
  exports: [DB],
})
export class DbModule {}
