import { Inject, Injectable } from '@nestjs/common';
import { AddEmploymentRequest, CreatePersonRequest, EmploymentInput, ListPeopleQuery, PersonDetail, PersonList } from '@ageless/core-contracts';
import { DB, Db, Tx } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext } from '../../../../platform/http/request-context';
import { CoreFacade } from '../../../core/core.facade';
import { PeopleRepository } from '../infrastructure/people.repository';
import { prepareContacts } from '../domain/contacts';

/** Use cases live here: open the transaction, call repositories and other facades, write the outbox event. */
@Injectable()
export class PeopleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PeopleRepository) private readonly repo: PeopleRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  health() { return { module: 'hrms', sub: 'people', ok: true }; }

  /** Person, contacts and first (primary) employment in one transaction: all saved or none. */
  async create(ctx: RequestContext, req: CreatePersonRequest): Promise<{ publicId: string }> {
    return this.db.transaction(async (tx) => {
      const refs = await this.employmentRefs(tx, ctx.tenantId, req.employment);
      const person = await this.core.createPerson(tx, {
        tenantId: ctx.tenantId, personType: 'employee', displayName: req.displayName, contacts: prepareContacts(req.contacts),
      });
      await this.repo.insertEmployment(tx, { ...this.employmentRow(ctx.tenantId, person.id, req.employment, refs), isPrimary: true });
      return { publicId: person.publicId };
    });
  }

  /** Another employment for an existing person (for example a second company). */
  async addEmployment(ctx: RequestContext, personPublicId: string, req: AddEmploymentRequest): Promise<{ publicId: string }> {
    return this.db.transaction(async (tx) => {
      const personId = await this.repo.findPersonId(tx, ctx.tenantId, personPublicId);
      if (!personId) throw new AppError('HRMS_PERSON_NOT_FOUND', 404, 'Person not found');
      const refs = await this.employmentRefs(tx, ctx.tenantId, req);
      if (refs.managerPersonId === personId) throw new AppError('HRMS_SELF_MANAGER', 400, 'A person cannot be their own manager');
      if (req.isPrimary) await this.repo.clearPrimaryEmployment(tx, personId);
      const publicId = await this.repo.insertEmployment(tx, { ...this.employmentRow(ctx.tenantId, personId, req, refs), isPrimary: req.isPrimary === true });
      return { publicId };
    });
  }

  list(ctx: RequestContext, q: ListPeopleQuery): Promise<PersonList> {
    return this.repo.list(ctx.tenantId, q);
  }

  async get(ctx: RequestContext, publicId: string): Promise<PersonDetail> {
    const person = await this.repo.getDetail(ctx.tenantId, publicId);
    if (!person) throw new AppError('HRMS_PERSON_NOT_FOUND', 404, 'Person not found');
    return person;
  }

  /** Company and manager given by code / public id, looked up in the caller's tenant. */
  private async employmentRefs(tx: Tx, tenantId: number, e: EmploymentInput) {
    const legalEntityId = await this.repo.findLegalEntityId(tx, tenantId, e.legalEntityCode);
    if (!legalEntityId) throw new AppError('HRMS_UNKNOWN_COMPANY', 400, `Unknown company ${e.legalEntityCode}`);
    let managerPersonId: number | null = null;
    if (e.managerPublicId) {
      managerPersonId = (await this.repo.findPersonId(tx, tenantId, e.managerPublicId)) ?? null;
      if (!managerPersonId) throw new AppError('HRMS_MANAGER_NOT_FOUND', 400, 'Manager not found');
    }
    return { legalEntityId, managerPersonId };
  }

  private employmentRow(tenantId: number, personId: number, e: EmploymentInput, refs: { legalEntityId: number; managerPersonId: number | null }) {
    return {
      tenantId, personId, ...refs, employeeCode: e.employeeCode, employmentType: e.engagementType,
      joinedOn: e.joinedOn, department: e.department, designation: e.designation,
    };
  }
}
