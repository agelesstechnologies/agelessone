import { Inject, Injectable } from '@nestjs/common';
import { PrivateDetails, UpdatePrivateRequest } from '@ageless/shared';
import { Conn, DB, Db } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { isManagement, RequestContext, requireAll } from '../../../../platform/http/request-context';
import { CoreFacade } from '../../../core/core.facade';
import { PrivateRepository } from '../infrastructure/private.repository';
import { maskAadhaar, maskAccount, maskPan } from '../domain/private-details';
import { PRIVATE } from '../domain/permissions';

/**
 * Aadhaar, PAN and salary bank accounts. HR and Management see them masked; Management (hrms.private.reveal) may see
 * them in full, and every reveal is written to the audit log. Values never go into the audit log or any other log.
 */
@Injectable()
export class PrivateService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PrivateRepository) private readonly repo: PrivateRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  /** Masked, for whoever holds hrms.private.view (all) or is Management; null for everyone else. */
  async masked(ctx: RequestContext, personPublicId: string): Promise<PrivateDetails | null> {
    if (ctx.permissions[PRIVATE.view] !== 'all' && !isManagement(ctx)) return null;
    const person = await this.repo.findPerson(this.db, ctx.tenantId, personPublicId);
    if (!person) return null;
    return this.details(this.db, ctx.tenantId, person.id, true);
  }

  /** In full; the reveal (who, whose, when) is written to the audit log in the same transaction. */
  async reveal(ctx: RequestContext, personPublicId: string): Promise<PrivateDetails> {
    requireAll(ctx, PRIVATE.reveal);
    return this.db.transaction(async (tx) => {
      const person = await this.repo.findPerson(tx, ctx.tenantId, personPublicId);
      if (!person) throw new AppError('HRMS_PERSON_NOT_FOUND', 404, 'Person not found');
      const details = await this.details(tx, ctx.tenantId, person.id, false);
      await this.core.audit(tx, {
        tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'private.revealed', entity: 'person', entityPublicId: personPublicId,
        subjectPersonId: person.id, summary: `Private details of ${person.displayName} revealed`,
        details: { aadhaar: details.aadhaar !== null, pan: details.pan !== null, bankAccounts: details.bankAccounts.length },
      });
      return details;
    });
  }

  /** HR: set or clear Aadhaar / PAN. The audit entry names the fields changed, never the values. Answers masked. */
  async update(ctx: RequestContext, personPublicId: string, req: UpdatePrivateRequest): Promise<PrivateDetails> {
    requireAll(ctx, PRIVATE.manage);
    return this.db.transaction(async (tx) => {
      const person = await this.repo.findPerson(tx, ctx.tenantId, personPublicId);
      if (!person) throw new AppError('HRMS_PERSON_NOT_FOUND', 404, 'Person not found');
      const patch = { ...(req.aadhaar !== undefined && { aadhaar: req.aadhaar }), ...(req.pan !== undefined && { pan: req.pan }) };
      await this.repo.upsert(tx, ctx.tenantId, person.id, patch, ctx.personId);
      await this.core.audit(tx, {
        tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'private.updated', entity: 'person', entityPublicId: personPublicId,
        subjectPersonId: person.id, summary: `Private details of ${person.displayName} changed (${Object.keys(patch).join(', ')})`,
        details: { fields: Object.keys(patch) },
      });
      return this.details(tx, ctx.tenantId, person.id, true);
    });
  }

  private async details(conn: Conn, tenantId: number, personId: number, masked: boolean): Promise<PrivateDetails> {
    const ids = await this.repo.ids(conn, personId);
    const accounts = await this.repo.bankAccounts(conn, tenantId, personId);
    return {
      masked,
      aadhaar: ids.aadhaar && (masked ? maskAadhaar(ids.aadhaar) : ids.aadhaar),
      pan: ids.pan && (masked ? maskPan(ids.pan) : ids.pan),
      bankAccounts: accounts.map((a) => ({ ...a, accountNumber: masked ? maskAccount(a.accountNumber) : a.accountNumber })),
    };
  }
}
