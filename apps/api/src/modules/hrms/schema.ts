import { pgSchema } from 'drizzle-orm/pg-core';
/** The PostgreSQL schema that only the HRMS module writes to. */
export const hrms = pgSchema('hrms');
