import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DB, Db } from '../../../../platform/db/db.module';
import { loginThrottle, permissions, persons, roleAssignments, rolePermissions, roles, users } from '../../schema';
import { Scope } from '../domain/login';

const userColumns = {
  id: users.id, publicId: users.publicId, tenantId: users.tenantId, personId: users.personId,
  loginPhone: users.loginPhone, loginEmail: users.loginEmail, passwordHash: users.passwordHash,
  isActive: users.isActive, passwordChangedAt: users.passwordChangedAt,
  personPublicId: persons.publicId, personName: persons.displayName, personStatus: persons.status,
};

/** Reads and writes core.users, roles and role assignments. */
@Injectable()
export class AuthRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- sign-in throttling (core.login_throttle) ----

  /** The lockouts in force for these keys (account and IP). */
  async lockouts(keys: string[]): Promise<(Date | null)[]> {
    const rows = await this.db.select({ lockedUntil: loginThrottle.lockedUntil }).from(loginThrottle).where(inArray(loginThrottle.key, keys));
    return rows.map((r) => r.lockedUntil);
  }

  /**
   * Counts one failed sign-in for the key, in one statement (parallel guesses cannot slip past the limit): failures older
   * than the window start a new count. Reaching `max` locks the key until now + lockout and starts the count again.
   * Answers when the key is locked until, or null.
   */
  async recordFailure(key: string, now: Date, max: number, windowMs: number, lockoutMs: number): Promise<Date | null> {
    const windowStart = new Date(now.getTime() - windowMs);
    const lockedUntil = new Date(now.getTime() + lockoutMs);
    // the count after this failure: 1 when the earlier ones are older than the window
    const count = sql`(CASE WHEN t.window_started_at <= ${windowStart} THEN 1 ELSE t.failures + 1 END)`;
    const { rows } = await this.db.execute<{ locked_until: Date | string | null }>(sql`
      INSERT INTO ${loginThrottle} AS t (key, failures, window_started_at, locked_until)
      VALUES (${key}, CASE WHEN 1 >= ${max} THEN 0 ELSE 1 END, ${now}, CASE WHEN 1 >= ${max} THEN ${lockedUntil}::timestamptz END)
      ON CONFLICT (key) DO UPDATE SET
        failures = CASE WHEN ${count} >= ${max} THEN 0 ELSE ${count} END,
        window_started_at = CASE WHEN ${count} >= ${max} OR t.window_started_at <= ${windowStart} THEN ${now}::timestamptz ELSE t.window_started_at END,
        locked_until = CASE WHEN ${count} >= ${max} THEN ${lockedUntil}::timestamptz ELSE t.locked_until END
      RETURNING locked_until`);
    const until = rows[0]?.locked_until ?? null;
    return until === null ? null : new Date(until);
  }

  /** A successful sign-in (or a password reset) clears the account's count and lockout. */
  async clearThrottle(keys: string[]): Promise<void> {
    await this.db.update(loginThrottle).set({ failures: 0, lockedUntil: null }).where(inArray(loginThrottle.key, keys));
  }

  /** Counts that ended long ago and are not locked are forgotten (keeps the table small). */
  async forgetOldThrottles(before: Date, now: Date): Promise<void> {
    await this.db.delete(loginThrottle).where(and(lte(loginThrottle.windowStartedAt, before), or(isNull(loginThrottle.lockedUntil), lte(loginThrottle.lockedUntil, now))));
  }

  async findUserByLogin(login: { email: string } | { phone: string }) {
    const where = 'email' in login ? eq(users.loginEmail, login.email) : eq(users.loginPhone, login.phone);
    const [row] = await this.db.select(userColumns).from(users).innerJoin(persons, eq(persons.id, users.personId)).where(where);
    return row;
  }

  async findUser(tenantId: number, publicId: string) {
    const [row] = await this.db.select(userColumns).from(users).innerJoin(persons, eq(persons.id, users.personId))
      .where(and(eq(users.tenantId, tenantId), eq(users.publicId, publicId)));
    return row;
  }

  async markLoggedIn(userId: number): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  }

  async setPassword(userId: number, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash, passwordChangedAt: new Date() }).where(eq(users.id, userId));
  }

  /** Every permission the person holds today, with the scope of the role that gives it. */
  async grantsInForce(tenantId: number, personId: number, today: string): Promise<{ code: string; scope: Scope }[]> {
    const rows = await this.db.select({ code: permissions.code, scope: roleAssignments.scope })
      .from(roleAssignments)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roleAssignments.roleId))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(and(eq(roleAssignments.tenantId, tenantId), eq(roleAssignments.personId, personId), this.inForce(today)));
    return rows as { code: string; scope: Scope }[];
  }

  async rolesInForce(tenantId: number, personId: number, today: string) {
    const rows = await this.db.select({ publicId: roleAssignments.publicId, code: roles.code, name: roles.name, scope: roleAssignments.scope })
      .from(roleAssignments).innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(and(eq(roleAssignments.tenantId, tenantId), eq(roleAssignments.personId, personId), this.inForce(today)))
      .orderBy(roles.code);
    return rows as { publicId: string; code: string; name: string; scope: Scope }[];
  }

  async findPersonId(tenantId: number, publicId: string): Promise<number | undefined> {
    const [row] = await this.db.select({ id: persons.id }).from(persons).where(and(eq(persons.tenantId, tenantId), eq(persons.publicId, publicId)));
    return row?.id;
  }

  async findRoleId(tenantId: number, code: string): Promise<number | undefined> {
    const [row] = await this.db.select({ id: roles.id }).from(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.code, code)));
    return row?.id;
  }

  async insertUser(u: { tenantId: number; personId: number; loginPhone: string | null; loginEmail: string | null; passwordHash: string }): Promise<string> {
    const [row] = await this.db.insert(users).values(u).returning({ publicId: users.publicId });
    return row.publicId;
  }

  async insertRoleAssignment(a: { tenantId: number; personId: number; roleId: number; scope: Scope; validFrom: string; validTo?: string; grantedBy: number }): Promise<string> {
    const [row] = await this.db.insert(roleAssignments).values(a).returning({ publicId: roleAssignments.publicId });
    return row.publicId;
  }

  async findRoleAssignment(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: roleAssignments.id, endedAt: roleAssignments.endedAt }).from(roleAssignments)
      .where(and(eq(roleAssignments.tenantId, tenantId), eq(roleAssignments.publicId, publicId)));
    return row;
  }

  async endRoleAssignment(id: number): Promise<void> {
    await this.db.update(roleAssignments).set({ endedAt: new Date() }).where(eq(roleAssignments.id, id));
  }

  private inForce(today: string) {
    return and(isNull(roleAssignments.endedAt), lte(roleAssignments.validFrom, today),
      or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, today)) ?? sql`true`);
  }
}
