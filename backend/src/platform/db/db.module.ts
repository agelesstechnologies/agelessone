import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import { PgDatabase } from 'drizzle-orm/pg-core';

export const DB = Symbol('DB');
export type Db = NodePgDatabase;
/** The handle inside db.transaction(async (tx) => ...); pass it to every write of one use case. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either the pool or a transaction: for reads that run both inside and outside a use case's transaction. */
export type Conn = PgDatabase<NodePgQueryResultHKT>;

/** The message of a PostgreSQL error (e.g. one raised by a trigger), looking inside Drizzle's wrapper. */
export function databaseMessage(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; message?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (typeof e.code === 'string' && typeof e.message === 'string') return e.message;
  }
  return undefined;
}

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
