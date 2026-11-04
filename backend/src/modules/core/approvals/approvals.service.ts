import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { DB, Db } from '../../../platform/db/db.module';
import { todayIst } from '../../../platform/time';
import { persons, roleAssignments, roles } from '../schema';
import { pickApprover } from './domain/approver';

/** The job's own approvers, looked up by the module that owns the job. */
export interface JobApprovers { managerId: number | null; departmentHeadId: number | null }

/** Who approves a request (leave, correction ...). Other modules ask through CoreFacade.approverFor. */
@Injectable()
export class ApprovalsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The job's manager, then its department's head, then HR, then the CEO — never one of `notAllowed`. HR and CEO are
   * the active holders of those roles today, oldest assignment first.
   */
  async approverFor(tenantId: number, notAllowed: number[], job: JobApprovers): Promise<number | null> {
    const today = todayIst();
    const people = await this.db.select({ personId: roleAssignments.personId, role: roles.code }).from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .innerJoin(persons, eq(persons.id, roleAssignments.personId))
      .where(and(eq(roleAssignments.tenantId, tenantId), inArray(roles.code, ['hr', 'ceo']), isNull(roleAssignments.endedAt),
        lte(roleAssignments.validFrom, today), or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, today)), eq(persons.status, 'active')))
      .orderBy(asc(roleAssignments.id));
    return pickApprover(notAllowed, {
      managerId: job.managerId, departmentHeadId: job.departmentHeadId,
      hrIds: people.filter((p) => p.role === 'hr').map((p) => p.personId),
      ceoIds: people.filter((p) => p.role === 'ceo').map((p) => p.personId),
    });
  }
}
