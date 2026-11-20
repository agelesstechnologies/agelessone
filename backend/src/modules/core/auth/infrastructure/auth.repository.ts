import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DB, Db } from '../../../../platform/db/db.module';
import { loginCodes, loginThrottle, machineCredentials, permissions, persons, roleAssignments, rolePermissions, roles, users } from '../../schema';
import { Scope } from '../domain/login';

const userColumns = {
  id: users.id, publicId: users.publicId, tenantId: users.tenantId, personId: users.personId,
  loginPhone: users.loginPhone, loginEmail: users.loginEmail, passwordHash: users.passwordHash,
  isActive: users.isActive, passwordChangedAt: users.passwordChangedAt, mustChangePassword: users.mustChangePassword,
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

  // ---- machine credentials (the Tally connector) ----

  async findMachineByClientId(clientId: string) {
    const [row] = await this.db.select().from(machineCredentials).where(eq(machineCredentials.clientId, clientId));
    return row;
  }

  async findMachine(tenantId: number, publicId: string) {
    const [row] = await this.db.select().from(machineCredentials).where(and(eq(machineCredentials.tenantId, tenantId), eq(machineCredentials.publicId, publicId)));
    return row;
  }

  async insertMachine(v: typeof machineCredentials.$inferInsert) {
    const [row] = await this.db.insert(machineCredentials).values(v).returning();
    return row!;
  }

  listMachines(tenantId: number) {
    return this.db.select().from(machineCredentials).where(eq(machineCredentials.tenantId, tenantId)).orderBy(machineCredentials.id);
  }

  async revokeMachine(id: number): Promise<void> {
    await this.db.update(machineCredentials).set({ isActive: false, revokedAt: new Date() }).where(eq(machineCredentials.id, id));
  }

  async markMachineUsed(id: number): Promise<void> {
    await this.db.update(machineCredentials).set({ lastUsedAt: new Date() }).where(eq(machineCredentials.id, id));
  }

  async markLoggedIn(userId: number): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  }

  /** mustChange: someone else chose it (an admin reset), so the person must set their own at the next sign-in. */
  async setPassword(userId: number, passwordHash: string, mustChange = false): Promise<void> {
    await this.db.update(users).set({ passwordHash, passwordChangedAt: new Date(), mustChangePassword: mustChange }).where(eq(users.id, userId));
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

  /** The roles that can be given, by name. */
  async allRoles(tenantId: number) {
    return this.db.select({ code: roles.code, name: roles.name }).from(roles).where(eq(roles.tenantId, tenantId)).orderBy(roles.name);
  }

  async loginOfPerson(personId: number) {
    const [row] = await this.db.select({ publicId: users.publicId, loginEmail: users.loginEmail, loginPhone: users.loginPhone, isActive: users.isActive })
      .from(users).where(eq(users.personId, personId));
    return row;
  }

  async findPersonId(tenantId: number, publicId: string): Promise<number | undefined> {
    const [row] = await this.db.select({ id: persons.id }).from(persons).where(and(eq(persons.tenantId, tenantId), eq(persons.publicId, publicId)));
    return row?.id;
  }

  async findRoleId(tenantId: number, code: string): Promise<number | undefined> {
    const [row] = await this.db.select({ id: roles.id }).from(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.code, code)));
    return row?.id;
  }

  async insertUser(u: { tenantId: number; personId: number; loginPhone: string | null; loginEmail: string | null; passwordHash: string; mustChangePassword: boolean }): Promise<string> {
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

  // ---- sign-in codes ----

  async insertCode(c: { tenantId: number; userId: number; purpose: 'first_login' | 'reset'; codeHash: string; expiresAt: Date }): Promise<void> {
    await this.db.insert(loginCodes).values(c);
  }

  /** The newest code of this purpose for the login. */
  async latestCode(userId: number, purpose: 'first_login' | 'reset') {
    const [row] = await this.db.select({ id: loginCodes.id, codeHash: loginCodes.codeHash, expiresAt: loginCodes.expiresAt,
      attempts: loginCodes.attempts, usedAt: loginCodes.usedAt }).from(loginCodes)
      .where(and(eq(loginCodes.userId, userId), eq(loginCodes.purpose, purpose))).orderBy(sql`${loginCodes.createdAt} DESC`).limit(1);
    return row;
  }

  async codesSentSince(userId: number, since: Date): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(loginCodes)
      .where(and(eq(loginCodes.userId, userId), gte(loginCodes.createdAt, since)));
    return row.n;
  }

  async countWrongTry(codeId: number): Promise<void> {
    await this.db.update(loginCodes).set({ attempts: sql`${loginCodes.attempts} + 1` }).where(eq(loginCodes.id, codeId));
  }

  async useCode(codeId: number): Promise<void> {
    await this.db.update(loginCodes).set({ usedAt: new Date() }).where(eq(loginCodes.id, codeId));
  }

  /**
   * Is the person in the caller's team: an active job managed by the caller, or in a department the caller heads?
   * (Plain SQL on hrms tables, so core does not depend on the HRMS module.)
   */
  async inTeamOf(tenantId: number, callerPersonId: number, personId: number): Promise<boolean> {
    const rows = await this.db.execute(sql`
      SELECT 1 FROM hrms.employments e LEFT JOIN hrms.departments d ON d.id = e.department_id
       WHERE e.tenant_id = ${tenantId} AND e.person_id = ${personId} AND e.status <> 'exited'
         AND (e.manager_person_id = ${callerPersonId} OR d.head_person_id = ${callerPersonId})
       LIMIT 1`);
    return rows.rows.length > 0;
  }

  async personHasLogin(personId: number): Promise<boolean> {
    const [row] = await this.db.select({ id: users.id }).from(users).where(eq(users.personId, personId));
    return row !== undefined;
  }

  private inForce(today: string) {
    return and(isNull(roleAssignments.endedAt), lte(roleAssignments.validFrom, today),
      or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, today)) ?? sql`true`);
  }
}
