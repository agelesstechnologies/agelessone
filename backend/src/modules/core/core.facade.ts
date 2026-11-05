import { Inject, Injectable } from '@nestjs/common';
import { POLICIES, PolicyKey, PolicyValue } from '@ageless/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { Conn, Tx } from '../../platform/db/db.module';
import { personContacts, persons } from './schema';
import { PolicyService } from './policies/application/policy.service';
import { ApprovalsService, JobApprovers } from './approvals/approvals.service';
import { AuditEntry, AuditService } from './audit/audit.service';

export interface NewPerson {
  tenantId: number;
  personType: 'employee' | 'external_worker' | 'contractor_staff';
  displayName: string;
  contacts: NewContact[];
}
export interface NewContact { kind: string; value: string; label?: string; isPrimary: boolean }

/** The only Core entry point other modules may use. */
@Injectable()
export class CoreFacade {
  constructor(
    @Inject(PolicyService) private readonly policies: PolicyService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(AuditService) private readonly auditLog: AuditService,
  ) {}

  /** Writes an audit entry inside the caller's transaction (append-only). */
  audit(conn: Conn, entry: AuditEntry): Promise<void> {
    return this.auditLog.write(conn, entry);
  }

  /**
   * A person whose own requests need no approval: they hold one of the roles in the policy
   * hrms.approvals.auto_approve_roles (default: ceo) for the company. Tied to the role, never to a named person.
   */
  async needsNoApproval(tenantId: number, personId: number, companyId: number, onDate: string): Promise<boolean> {
    const roles = await this.getPolicy(tenantId, 'hrms.approvals.auto_approve_roles', companyId, onDate);
    if (roles.length === 0) return false;
    return (await this.approvals.rolesOf(tenantId, personId)).some((r) => roles.includes(r));
  }

  /** Who decides a request: manager, then department head, then HR, then CEO — never one of notAllowed (person ids). */
  approverFor(tenantId: number, notAllowed: number[], job: JobApprovers): Promise<number | null> {
    return this.approvals.approverFor(tenantId, notAllowed, job);
  }

  /**
   * A company policy in force on a date: the company's own newest version, else the group's, else the built-in default
   * (POLICIES in @ageless/shared). companyId null asks for the group value.
   */
  getPolicy<K extends PolicyKey>(tenantId: number, key: K, companyId: number | null, onDate: string): Promise<PolicyValue<K>> {
    return this.policies.get(tenantId, key, companyId, onDate, POLICIES[key].default as PolicyValue<K>);
  }

  /** Creates a person and their contacts inside the caller's transaction. The internal id is for foreign keys only. */
  async createPerson(tx: Tx, p: NewPerson): Promise<{ id: number; publicId: string }> {
    const [person] = await tx.insert(persons)
      .values({ tenantId: p.tenantId, personType: p.personType, displayName: p.displayName, fullName: p.displayName })
      .returning({ id: persons.id, publicId: persons.publicId });
    if (p.contacts.length) {
      await tx.insert(personContacts).values(p.contacts.map((c) => ({ tenantId: p.tenantId, personId: person.id, ...c })));
    }
    return person;
  }

  async updatePerson(tx: Tx, personId: number, patch: { displayName?: string; status?: string }): Promise<void> {
    await tx.update(persons).set(patch).where(eq(persons.id, personId));
  }

  /** Adds a contact. A primary one first un-marks the person's current primary of the same kind. */
  async addContact(tx: Tx, tenantId: number, personId: number, c: NewContact): Promise<string> {
    if (c.isPrimary) {
      await tx.update(personContacts).set({ isPrimary: false }).where(and(eq(personContacts.personId, personId),
        eq(personContacts.kind, c.kind), eq(personContacts.isPrimary, true), isNull(personContacts.endedAt)));
    }
    const [row] = await tx.insert(personContacts).values({ tenantId, personId, ...c }).returning({ publicId: personContacts.publicId });
    return row.publicId;
  }

  /** Ends a contact (never deleted). It keeps its old primary flag as history; the person has no current primary of that kind. */
  async endContact(tx: Tx, tenantId: number, contactPublicId: string): Promise<'ended' | 'not_found' | 'already_ended'> {
    const [c] = await tx.select({ id: personContacts.id, endedAt: personContacts.endedAt }).from(personContacts)
      .where(and(eq(personContacts.tenantId, tenantId), eq(personContacts.publicId, contactPublicId))).for('update');
    if (!c) return 'not_found';
    if (c.endedAt) return 'already_ended';
    await tx.update(personContacts).set({ endedAt: new Date() }).where(eq(personContacts.id, c.id));
    return 'ended';
  }
}
