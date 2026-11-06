import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import {
  CompletionRules, CreateTicketTypeRequest, TicketField, TicketType, TicketTypeDetail, TicketTypesQuery, TicketTypeVersion, UpdateTicketTypeRequest,
} from '@ageless/shared';
import { DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CoreFacade } from '../../core/core.facade';
import { TypeRow, TicketTypesRepository } from '../infrastructure/ticket-types.repository';
import { whyNotManage } from '../domain/access';
import { TICKET_TYPES } from '../domain/permissions';

type Content = Pick<TypeRow, 'name' | 'ownerDepartmentId' | 'sortOrder' | 'fields' | 'completionRules' | 'checklistItems'>;

/**
 * Ticket types: what a kind of work asks for (fields) and what it needs before it can be completed (rules, checklist).
 * One row per saved version; editing adds a version and keeps the old ones. Types are deactivated, never deleted.
 * Scope all (admin user, Management) manages every type; a department head manages the non-standard types their
 * department owns; everyone else only reads.
 */
@Injectable()
export class TicketTypesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TicketTypesRepository) private readonly repo: TicketTypesRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  async list(ctx: RequestContext, q: TicketTypesQuery): Promise<TicketType[]> {
    let departmentId: number | undefined;
    if (q.department) {
      const dept = await this.repo.findDepartment(ctx.tenantId, q.department);
      if (!dept) return [];
      departmentId = dept.id;
    }
    return (await this.repo.list(ctx.tenantId, { active: q.active, departmentId, company: q.company })).map(toType);
  }

  async get(ctx: RequestContext, publicId: string): Promise<TicketTypeDetail> {
    return this.detail(this.db, ctx.tenantId, publicId);
  }

  /**
   * For creating a ticket: the type's current version, only while it is active (409 TICKETS_TYPE_INACTIVE otherwise).
   * A deactivated type keeps its old tickets but takes no new ones.
   */
  async requireActiveType(tenantId: number, publicId: string): Promise<TicketType> {
    return toType(await this.activeRow(tenantId, publicId));
  }

  /** The current, active version a new ticket will use (internal ids included). Same errors as requireActiveType. */
  async activeVersion(tenantId: number, publicId: string): Promise<ActiveTypeVersion> {
    return toActive(await this.activeRow(tenantId, publicId));
  }

  /** The company's active type with this code (e.g. production, for rework tickets), if there is one. */
  async activeVersionByCode(tenantId: number, legalEntityId: number, code: string): Promise<ActiveTypeVersion | undefined> {
    const row = await this.repo.currentByCode(this.db, tenantId, legalEntityId, code);
    return row?.active ? toActive(row) : undefined;
  }

  private async activeRow(tenantId: number, publicId: string): Promise<TypeRow> {
    const row = await this.repo.current(this.db, tenantId, publicId);
    if (!row) throw new AppError('TICKETS_TYPE_NOT_FOUND', 404, 'Unknown ticket type');
    if (!row.active) throw new AppError('TICKETS_TYPE_INACTIVE', 409, `The ticket type "${row.name}" is deactivated and takes no new tickets`);
    return row;
  }

  /** A new, non-standard type. The same publicId again answers the stored type (created: false). */
  async create(ctx: RequestContext, req: CreateTicketTypeRequest): Promise<{ type: TicketTypeDetail; created: boolean }> {
    const publicId = req.publicId ?? randomUUID();
    if (req.publicId) {
      const tenant = await this.repo.tenantOf(req.publicId);
      if (tenant === ctx.tenantId) return { type: await this.detail(this.db, ctx.tenantId, publicId), created: false };
      if (tenant !== undefined) throw new AppError('TICKETS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const company = await this.repo.findCompany(ctx.tenantId, req.company);
    if (!company) throw new AppError('TICKETS_UNKNOWN_COMPANY', 400, `Unknown company ${req.company}`);
    let department: { id: number; legalEntityId: number; headPersonId: number | null } | undefined;
    if (req.ownerDepartmentPublicId) {
      department = await this.repo.findDepartment(ctx.tenantId, req.ownerDepartmentPublicId);
      if (!department || department.legalEntityId !== company.id) {
        throw new AppError('TICKETS_UNKNOWN_DEPARTMENT', 400, `That department does not belong to ${company.code}`);
      }
    }
    const denied = whyNotManage(ctx.permissions[TICKET_TYPES.manage], { isStandard: false, ownerDepartmentId: department?.id ?? null },
      department?.headPersonId === ctx.personId);
    if (denied) throw new AppError('TICKETS_TYPE_FORBIDDEN', 403, 'You can create types only for a department you head; company-wide types are for admin and Management');

    try {
      await this.db.transaction(async (tx) => {
        await this.repo.insert(tx, { tenantId: ctx.tenantId, publicId, version: 1, legalEntityId: company.id, code: req.code, name: req.name,
          ownerDepartmentId: department?.id ?? null, isStandard: false, active: true, sortOrder: req.sortOrder, fields: req.fields,
          completionRules: req.completionRules, checklistItems: req.checklistItems, createdBy: ctx.personId });
        await this.audit(tx, ctx, 'tickets.type.created', publicId, company.id, `Created ticket type ${req.name}`, { code: req.code, version: 1, company: company.code });
      });
    } catch (err) {
      throw this.refuse(err) ?? err;
    }
    return { type: await this.detail(this.db, ctx.tenantId, publicId), created: true };
  }

  /** A real change saves a new version (the old one is kept); sending what is already stored changes nothing. */
  async update(ctx: RequestContext, publicId: string, req: UpdateTicketTypeRequest): Promise<TicketTypeDetail> {
    try {
      return await this.db.transaction(async (tx) => {
        const current = await this.lockedCurrent(tx, ctx, publicId);
        await this.requireManage(ctx, current, tx);
        if (req.expectedVersion !== undefined && req.expectedVersion !== current.version) {
          throw new AppError('TICKETS_TYPE_VERSION_CONFLICT', 409, `The type is now at version ${current.version}; reload and try again`, { version: current.version });
        }
        let ownerDepartmentId = current.ownerDepartmentId;
        if (req.ownerDepartmentPublicId !== undefined) {
          if (ctx.permissions[TICKET_TYPES.manage] !== 'all') throw new AppError('TICKETS_TYPE_FORBIDDEN', 403, 'Only admin and Management can move a type to another department');
          if (req.ownerDepartmentPublicId === null) ownerDepartmentId = null;
          else {
            const dept = await this.repo.findDepartment(ctx.tenantId, req.ownerDepartmentPublicId);
            if (!dept || dept.legalEntityId !== current.legalEntityId) throw new AppError('TICKETS_UNKNOWN_DEPARTMENT', 400, `That department does not belong to ${current.company}`);
            ownerDepartmentId = dept.id;
          }
        }
        const next: Content = {
          name: req.name ?? current.name, ownerDepartmentId, sortOrder: req.sortOrder ?? current.sortOrder, fields: req.fields ?? current.fields,
          completionRules: req.completionRules ?? current.completionRules, checklistItems: req.checklistItems ?? current.checklistItems,
        };
        const changed = (Object.keys(next) as (keyof Content)[]).filter((k) => !isDeepStrictEqual(next[k], current[k]));
        if (changed.length === 0) return this.detail(tx, ctx.tenantId, publicId);
        if (parseRules(next.completionRules).checklist_required && (next.checklistItems as string[]).length === 0) {
          throw new AppError('TICKETS_CHECKLIST_EMPTY', 400, 'checklist_required needs at least one checklist item');
        }
        await this.repo.retire(tx, current.id);
        await this.repo.insert(tx, { tenantId: ctx.tenantId, publicId, version: current.version + 1, legalEntityId: current.legalEntityId, code: current.code,
          isStandard: current.isStandard, active: current.active, createdBy: ctx.personId, ...next });
        await this.audit(tx, ctx, 'tickets.type.updated', publicId, current.legalEntityId, `Changed ticket type ${current.name} (version ${current.version + 1})`,
          { code: current.code, version: current.version + 1, changed });
        return this.detail(tx, ctx.tenantId, publicId);
      });
    } catch (err) {
      throw this.refuse(err) ?? err;
    }
  }

  deactivate(ctx: RequestContext, publicId: string): Promise<TicketTypeDetail> {
    return this.setActive(ctx, publicId, false);
  }

  reactivate(ctx: RequestContext, publicId: string): Promise<TicketTypeDetail> {
    return this.setActive(ctx, publicId, true);
  }

  // ---- helpers ----

  /** Already in the wanted state: nothing changes and nothing is audited. */
  private setActive(ctx: RequestContext, publicId: string, active: boolean): Promise<TicketTypeDetail> {
    return this.db.transaction(async (tx) => {
      const current = await this.lockedCurrent(tx, ctx, publicId);
      await this.requireManage(ctx, current, tx);
      if (current.active !== active) {
        await this.repo.setActive(tx, current.id, active);
        await this.audit(tx, ctx, active ? 'tickets.type.reactivated' : 'tickets.type.deactivated', publicId, current.legalEntityId,
          `${active ? 'Reactivated' : 'Deactivated'} ticket type ${current.name}`, { code: current.code, version: current.version });
      }
      return this.detail(tx, ctx.tenantId, publicId);
    });
  }

  private async lockedCurrent(tx: Tx, ctx: RequestContext, publicId: string): Promise<TypeRow> {
    const row = await this.repo.current(tx, ctx.tenantId, publicId, true);
    if (!row) throw new AppError('TICKETS_TYPE_NOT_FOUND', 404, 'Unknown ticket type');
    return row;
  }

  private async requireManage(ctx: RequestContext, type: TypeRow, conn: Tx): Promise<void> {
    const head = type.ownerDepartmentId === null ? null : await this.repo.departmentHead(conn, type.ownerDepartmentId);
    const denied = whyNotManage(ctx.permissions[TICKET_TYPES.manage], type, head === ctx.personId);
    if (denied === 'STANDARD') throw new AppError('TICKETS_STANDARD_TYPE_LOCKED', 403, 'Standard types can be changed only by admin or Management');
    if (denied) throw new AppError('TICKETS_TYPE_FORBIDDEN', 403, 'You can change only the types of a department you head');
  }

  private async detail(conn: Parameters<TicketTypesRepository['versions']>[0], tenantId: number, publicId: string): Promise<TicketTypeDetail> {
    const versions = await this.repo.versions(conn, tenantId, publicId);
    const current = versions.find((v) => v.isCurrent);
    if (!current) throw new AppError('TICKETS_TYPE_NOT_FOUND', 404, 'Unknown ticket type');
    return { ...toType(current), versions: versions.map(toVersion) };
  }

  private audit(tx: Tx, ctx: RequestContext, action: string, publicId: string, legalEntityId: number, summary: string, details: Record<string, unknown>) {
    return this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action, entity: 'ticket_type', entityPublicId: publicId, legalEntityId, summary, details });
  }

  /** The clear error for a database rule a request broke, if it is one we know. */
  private refuse(err: unknown): AppError | undefined {
    switch (violatedConstraint(err)) {
      case 'ticket_types_company_name_unique': return new AppError('TICKETS_DUPLICATE_NAME', 409, 'This company already has a ticket type with that name');
      case 'ticket_types_company_code_unique': return new AppError('TICKETS_DUPLICATE_CODE', 409, 'This company already has a ticket type with that code');
      case 'ticket_types_public_version_unique': return new AppError('TICKETS_TYPE_VERSION_CONFLICT', 409, 'Someone saved this type at the same moment; reload and try again');
      default: return undefined;
    }
  }
}

const parseRules = (v: unknown): CompletionRules => CompletionRules.parse(v);

/** A type version as ticket code needs it. */
export interface ActiveTypeVersion {
  id: number; publicId: string; version: number; legalEntityId: number; code: string; name: string;
  fields: TicketField[]; completionRules: CompletionRules; checklistItems: string[];
}

function toActive(r: TypeRow): ActiveTypeVersion {
  return { id: r.id, publicId: r.publicId, version: r.version, legalEntityId: r.legalEntityId, code: r.code, name: r.name,
    fields: r.fields as TicketField[], completionRules: parseRules(r.completionRules), checklistItems: r.checklistItems as string[] };
}

function toVersion(r: TypeRow): TicketTypeVersion {
  return {
    version: r.version, isCurrent: r.isCurrent, name: r.name,
    ownerDepartment: r.departmentPublicId ? { publicId: r.departmentPublicId, name: r.departmentName as string } : null,
    sortOrder: r.sortOrder, fields: r.fields as TicketField[], completionRules: parseRules(r.completionRules), checklistItems: r.checklistItems as string[],
    createdBy: { publicId: r.createdByPublicId, displayName: r.createdByName }, createdAt: r.createdAt.toISOString(),
  };
}

function toType(r: TypeRow): TicketType {
  const { version, isCurrent: _current, ...content } = toVersion(r);
  return { publicId: r.publicId, version, company: r.company, code: r.code, isStandard: r.isStandard, active: r.active, ...content };
}
