import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CreateGrantRequest, Grant, GrantsQuery } from '@ageless/shared';
import { DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { crossCompanyGrants } from '../schema';
import { RequestsRepository } from '../infrastructure/requests.repository';
import { TICKET_TAKES_PARTS } from '../domain/stock-rules';
import { INVENTORY } from '../domain/permissions';
import { CompanyAccess } from './company-access.service';
import { isResentCreate, maybePersonRef, personRef } from './support';

type GrantRow = Awaited<ReturnType<RequestsRepository['grants']>>[number];

/**
 * Cross-company requesters: the store in-charge of the company that owns the stock lets a person from another company
 * request parts for one of its tickets, until an end date. The grant is the person's only right there: they request,
 * never see values, never approve. Every grant and its end is audited.
 */
@Injectable()
export class GrantsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RequestsRepository) private readonly repo: RequestsRepository,
    @Inject(CompanyAccess) private readonly access: CompanyAccess,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  /** The same publicId again answers the stored grant (created: false). */
  async create(ctx: RequestContext, req: CreateGrantRequest): Promise<{ grant: Grant; created: boolean }> {
    if (await this.access.alreadyStored(ctx, crossCompanyGrants, req.publicId)) return { grant: await this.one(ctx, req.publicId as string), created: false };
    const company = await this.access.require(ctx, [INVENTORY.requestsApprove], req.company);
    const personId = await this.repo.personByPublicId(this.db, ctx.tenantId, req.personPublicId);
    if (personId === undefined) throw new AppError('INVENTORY_UNKNOWN_PERSON', 400, 'Unknown person');
    if (personId === ctx.personId) throw new AppError('INVENTORY_GRANT_SELF', 400, 'Nobody grants themselves');
    const works = await this.repo.companiesOf(this.db, personId);
    if (works.includes(company.id)) {
      throw new AppError('INVENTORY_GRANT_SAME_COMPANY', 400, `That person works in ${company.code}: give them the Parts requester role instead`);
    }
    if (works.length === 0) throw new AppError('INVENTORY_GRANT_NO_JOB', 400, 'A grant is for a person with a current job in another company');
    const t = await this.repo.ticket(this.db, ctx.tenantId, req.ticketPublicId);
    if (!t || t.legalEntityId !== company.id) throw new AppError('INVENTORY_UNKNOWN_TICKET', 400, `That ticket does not belong to ${company.code}`);
    if (!TICKET_TAKES_PARTS.includes(t.status)) throw new AppError('INVENTORY_TICKET_CLOSED', 409, `Ticket ${t.number} is ${t.status}`);
    if (req.validUntil < todayIst()) throw new AppError('INVENTORY_GRANT_DATE', 400, 'A grant runs until today or later');
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.insertGrant(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: company.id, personId, ticketId: t.id, validUntil: req.validUntil, grantedBy: ctx.personId });
        await this.audit(tx, ctx, 'inventory.grant.created', publicId, company.id, personId,
          `Let a person from another company request parts for ticket ${t.number} of ${company.code} until ${req.validUntil}`, { ticket: t.number, validUntil: req.validUntil });
      });
    } catch (err) {
      if (isResentCreate(err)) return { grant: await this.one(ctx, publicId), created: false };
      if (violatedConstraint(err) === 'cross_company_grants_one_open') throw new AppError('INVENTORY_GRANT_EXISTS', 409, 'That person already has an open grant for this ticket');
      throw err;
    }
    return { grant: await this.one(ctx, publicId), created: true };
  }

  /** The grants of the companies the caller approves requests for. */
  async list(ctx: RequestContext, q: GrantsQuery): Promise<Grant[]> {
    const companies = await this.access.forList(ctx, [INVENTORY.requestsApprove], q.company);
    if (companies.length === 0) return [];
    const rows = (await this.repo.grants(this.db, ctx.tenantId, { companyIds: companies.map((c) => c.id) })).map(toGrant);
    return q.active === undefined ? rows : rows.filter((g) => g.active === q.active);
  }

  /** The caller's own grants: the tickets of other companies they may request parts for. */
  async mine(ctx: RequestContext): Promise<Grant[]> {
    return (await this.repo.grants(this.db, ctx.tenantId, { personId: ctx.personId })).map(toGrant);
  }

  async end(ctx: RequestContext, publicId: string): Promise<Grant> {
    await this.db.transaction(async (tx) => {
      const g = await this.repo.grant(tx, ctx.tenantId, publicId, true);
      if (!g || !(await this.access.mayUse(ctx, [INVENTORY.requestsApprove], g.legalEntityId))) throw new AppError('INVENTORY_GRANT_NOT_FOUND', 404, 'Unknown grant');
      if (g.endedAt) throw new AppError('INVENTORY_GRANT_ENDED', 409, 'That grant has already ended');
      await this.repo.endGrant(tx, g.id, ctx.personId);
      await this.audit(tx, ctx, 'inventory.grant.ended', publicId, g.legalEntityId, g.personId, 'Ended a cross-company grant', {});
    });
    return this.one(ctx, publicId);
  }

  private async one(ctx: RequestContext, publicId: string): Promise<Grant> {
    const [row] = await this.repo.grants(this.db, ctx.tenantId, { publicId });
    if (!row) throw new AppError('INVENTORY_GRANT_NOT_FOUND', 404, 'Unknown grant');
    return toGrant(row);
  }

  private audit(tx: Tx, ctx: RequestContext, action: string, publicId: string, legalEntityId: number, subjectPersonId: number, summary: string, details: Record<string, unknown>) {
    return this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action, entity: 'inventory_grant', entityPublicId: publicId, subjectPersonId,
      legalEntityId, summary, details });
  }
}

function toGrant(r: GrantRow): Grant {
  return {
    publicId: r.publicId, company: r.company, person: personRef(r.personPublicId ?? '', r.personName ?? ''),
    ticket: { publicId: r.ticketPublicId, number: r.ticketNumber, title: r.ticketTitle }, validUntil: r.validUntil,
    active: r.endedAt === null && r.validUntil >= todayIst(),
    grantedBy: personRef(r.grantedByPublicId ?? '', r.grantedByName ?? ''), createdAt: r.createdAt.toISOString(),
    endedBy: maybePersonRef(r.endedByPublicId, r.endedByName), endedAt: r.endedAt?.toISOString() ?? null,
  };
}
