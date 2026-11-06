import { Inject, Injectable } from '@nestjs/common';
import {
  AddContactRequest, AddEmploymentRequest, CreatePersonRequest, EmploymentInput, ExitEmploymentRequest, ListPeopleQuery,
  PersonDetail, PersonList, SharedContacts, UpdateEmploymentRequest, UpdatePersonRequest,
} from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { isManagement, RequestContext, requireAll } from '../../../../platform/http/request-context';
import { CoreFacade } from '../../../core/core.facade';
import { CONTENT_TYPES, detectDocumentType, discardUpload, DocumentType, readUpload, saveUpload } from '../../../../platform/storage';
import { EmploymentPatch, PeopleRepository } from '../infrastructure/people.repository';
import { normalizeContactValue, normalizeLookupValue, prepareContacts } from '../domain/contacts';
import { isValidExitDate, pickNextPrimary } from '../domain/employments';
import { nextEmployeeCode } from '../domain/employee-codes';
import { PEOPLE } from '../domain/permissions';
import { PrivateService } from './private.service';

/**
 * Use cases live here: open the transaction, call repositories and other facades, write the outbox event.
 * The guard has already checked the caller holds the permission; each use case checks the scope (own / team / all)
 * against the person it reads or changes.
 */
@Injectable()
export class PeopleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PeopleRepository) private readonly repo: PeopleRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
    @Inject(PrivateService) private readonly privacy: PrivateService,
  ) {}

  health() { return { module: 'hrms', sub: 'people', ok: true }; }

  /**
   * Person, contacts and first (primary) employment in one transaction: all saved or none. Without an employee code
   * the next code for the department's prefix is generated in the same transaction.
   */
  async create(ctx: RequestContext, req: CreatePersonRequest): Promise<{ publicId: string }> {
    requireAll(ctx, PEOPLE.create);
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
      const personId = await this.personId(tx, ctx.tenantId, personPublicId);
      await this.checkScope(tx, ctx, PEOPLE.manageEmployments, personId);
      const refs = await this.employmentRefs(tx, ctx.tenantId, req);
      if (refs.managerPersonId === personId) throw new AppError('HRMS_SELF_MANAGER', 400, 'A person cannot be their own manager');
      if (req.isPrimary) await this.repo.clearPrimaryEmployment(tx, personId);
      const publicId = await this.repo.insertEmployment(tx, { ...this.employmentRow(ctx.tenantId, personId, req, refs), isPrimary: req.isPrimary === true });
      return { publicId };
    });
  }

  async update(ctx: RequestContext, publicId: string, req: UpdatePersonRequest): Promise<PersonDetail> {
    await this.db.transaction(async (tx) => {
      const personId = await this.personId(tx, ctx.tenantId, publicId);
      await this.checkScope(tx, ctx, PEOPLE.update, personId);
      await this.core.updatePerson(tx, personId, req);
    });
    return this.detail(ctx, publicId);
  }

  async addContact(ctx: RequestContext, personPublicId: string, req: AddContactRequest): Promise<{ publicId: string }> {
    return this.db.transaction(async (tx) => {
      const personId = await this.personId(tx, ctx.tenantId, personPublicId);
      await this.checkScope(tx, ctx, PEOPLE.manageContacts, personId);
      const publicId = await this.core.addContact(tx, ctx.tenantId, personId, {
        kind: req.kind, value: normalizeContactValue(req.kind, req.value), label: req.label, isPrimary: req.isPrimary === true,
      });
      return { publicId };
    });
  }

  async endContact(ctx: RequestContext, contactPublicId: string): Promise<void> {
    const result = await this.db.transaction(async (tx) => {
      const personId = await this.repo.findContactPersonId(tx, ctx.tenantId, contactPublicId);
      if (personId === undefined) return 'not_found' as const;
      await this.checkScope(tx, ctx, PEOPLE.manageContacts, personId);
      return this.core.endContact(tx, ctx.tenantId, contactPublicId);
    });
    if (result === 'not_found') throw new AppError('HRMS_CONTACT_NOT_FOUND', 404, 'Contact not found');
    if (result === 'already_ended') throw new AppError('HRMS_CONTACT_ALREADY_ENDED', 409, 'This contact has already ended');
  }

  async sharedContacts(ctx: RequestContext, value: string): Promise<SharedContacts> {
    requireAll(ctx, PEOPLE.reviewContacts);
    const stored = normalizeLookupValue(value);
    return { value: stored, people: await this.repo.sharedContacts(ctx.tenantId, stored) };
  }

  /**
   * Manager, department (a transfer: the employee code stays), designation, or make primary (the person's other primary
   * is cleared in the same transaction).
   */
  async updateEmployment(ctx: RequestContext, publicId: string, req: UpdateEmploymentRequest): Promise<PersonDetail> {
    const personPublicId = await this.db.transaction(async (tx) => {
      const job = await this.employment(tx, ctx.tenantId, publicId);
      await this.checkScope(tx, ctx, PEOPLE.updateEmployments, job.personId);
      const patch: EmploymentPatch = {};
      if (req.managerPublicId !== undefined) {
        patch.managerPersonId = req.managerPublicId === null ? null : await this.managerId(tx, ctx.tenantId, req.managerPublicId);
        if (patch.managerPersonId === job.personId) throw new AppError('HRMS_SELF_MANAGER', 400, 'A person cannot be their own manager');
      }
      if (req.departmentCode !== undefined) {
        patch.departmentId = req.departmentCode === null ? null : (await this.department(tx, job.legalEntityId, req.departmentCode)).id;
      }
      if (req.designation !== undefined) patch.designation = req.designation;
      await this.repo.updateEmployment(tx, job.id, patch);
      if (req.isPrimary) {
        if (job.status !== 'active') throw new AppError('HRMS_EMPLOYMENT_NOT_ACTIVE', 409, 'Only an active employment can be primary');
        await this.repo.makePrimary(tx, job.personId, job.id);
      }
      return job.personPublicId;
    });
    return this.detail(ctx, personPublicId);
  }

  /** Exit one employment. Primary moves to another active one; with none left the person becomes inactive. */
  async exitEmployment(ctx: RequestContext, publicId: string, req: ExitEmploymentRequest): Promise<PersonDetail> {
    const personPublicId = await this.db.transaction(async (tx) => {
      const job = await this.employment(tx, ctx.tenantId, publicId);
      await this.checkScope(tx, ctx, PEOPLE.manageEmployments, job.personId);
      if (job.status === 'exited') throw new AppError('HRMS_EMPLOYMENT_NOT_ACTIVE', 409, 'This employment has already ended');
      if (!isValidExitDate(job.joinedOn, req.exitOn)) throw new AppError('HRMS_EXIT_BEFORE_JOIN', 400, 'Exit date is before the joining date');
      const nextPrimary = pickNextPrimary(await this.repo.otherActiveEmployments(tx, job.personId, job.id));
      await this.repo.exitEmployment(tx, job.id, req.exitOn, req.exitReason, job.isPrimary && nextPrimary === undefined);
      if (job.isPrimary && nextPrimary !== undefined) await this.repo.makePrimary(tx, job.personId, nextPrimary);
      if (nextPrimary === undefined) await this.core.updatePerson(tx, job.personId, { status: 'inactive' });
      return job.personPublicId;
    });
    return this.detail(ctx, personPublicId);
  }

  /** Offer accepted → started: a joining employment becomes active (then the person can punch, apply and claim). */
  async activate(ctx: RequestContext, publicId: string): Promise<PersonDetail> {
    const personPublicId = await this.db.transaction(async (tx) => {
      const job = await this.employment(tx, ctx.tenantId, publicId);
      await this.checkScope(tx, ctx, PEOPLE.manageEmployments, job.personId);
      if (job.status !== 'joining') throw new AppError('HRMS_EMPLOYMENT_NOT_JOINING', 409, 'Only a joining employment can be activated');
      await this.repo.activate(tx, job.id);
      return job.personPublicId;
    });
    return this.detail(ctx, personPublicId);
  }

  /** Stores the offer letter (PDF, JPEG or PNG, checked by its bytes) on the employment. */
  async uploadOfferLetter(ctx: RequestContext, publicId: string, file: { buffer: Buffer } | undefined): Promise<PersonDetail> {
    if (!file) throw new AppError('VALIDATION', 400, 'Attach the offer letter as the file field `file`');
    const type = detectDocumentType(file.buffer);
    if (!type) throw new AppError('HRMS_FILE_TYPE', 400, 'The offer letter must be a PDF, JPEG or PNG file');
    const path = await saveUpload('offer-letters', type, file.buffer);
    try {
      const personPublicId = await this.db.transaction(async (tx) => {
        const job = await this.employment(tx, ctx.tenantId, publicId);
        await this.checkScope(tx, ctx, PEOPLE.manageEmployments, job.personId);
        await this.repo.setOfferLetter(tx, job.id, path, type);
        return job.personPublicId;
      });
      return this.detail(ctx, personPublicId);
    } catch (err) {
      await discardUpload(path);
      throw err;
    }
  }

  /** The offer letter file: for the person themselves, or whoever may manage their employments. */
  async offerLetter(ctx: RequestContext, publicId: string): Promise<{ data: Buffer; contentType: string }> {
    const job = await this.db.transaction(async (tx) => {
      const j = await this.employment(tx, ctx.tenantId, publicId);
      if (j.personId !== ctx.personId && !isManagement(ctx)) await this.checkScope(tx, ctx, PEOPLE.manageEmployments, j.personId);
      return j;
    });
    if (!job.offerLetterPath) throw new AppError('HRMS_NO_OFFER_LETTER', 404, 'No offer letter stored for this employment');
    return { data: await readUpload(job.offerLetterPath), contentType: CONTENT_TYPES[job.offerLetterType as DocumentType] };
  }

  list(ctx: RequestContext, q: ListPeopleQuery): Promise<PersonList> {
    const scope = ctx.permissions[PEOPLE.view];
    return this.repo.list(ctx.tenantId, q, scope === 'all' ? undefined : { scope: scope === 'team' ? 'team' : 'own', personId: ctx.personId });
  }

  async get(ctx: RequestContext, publicId: string): Promise<PersonDetail> {
    await this.checkScope(this.db, ctx, PEOPLE.view, await this.personId(this.db, ctx.tenantId, publicId));
    return this.detail(ctx, publicId);
  }

  /** The person as the API shows them, without an access check (used after a change the caller was allowed to make). */
  private async detail(ctx: RequestContext, publicId: string): Promise<PersonDetail> {
    const person = await this.repo.getDetail(ctx.tenantId, publicId);
    if (!person) throw new AppError('HRMS_PERSON_NOT_FOUND', 404, 'Person not found');
    return { ...person, private: await this.privacy.masked(ctx, publicId) };
  }

  /**
   * Company, manager and department given by code / public id, looked up in the caller's tenant, and the employee code:
   * the one typed (imports), else the next for the department's prefix (the department row stays locked until commit,
   * so two new staff never get the same code).
   */
  private async employmentRefs(tx: Tx, tenantId: number, e: EmploymentInput): Promise<EmploymentRefs> {
    const legalEntityId = await this.repo.findLegalEntityId(tx, tenantId, e.legalEntityCode);
    if (!legalEntityId) throw new AppError('HRMS_UNKNOWN_COMPANY', 400, `Unknown company ${e.legalEntityCode}`);
    const managerPersonId = e.managerPublicId ? await this.managerId(tx, tenantId, e.managerPublicId) : null;
    const department = e.departmentCode ? await this.department(tx, legalEntityId, e.departmentCode, !e.employeeCode) : null;
    let employeeCode = e.employeeCode;
    if (!employeeCode) {
      if (!department) throw new AppError('HRMS_EMPLOYEE_CODE_REQUIRED', 400, 'Give an employee code, or a department to generate one');
      employeeCode = nextEmployeeCode(department.codePrefix, await this.repo.codesWithPrefix(tx, legalEntityId, department.codePrefix));
    }
    return { legalEntityId, managerPersonId, departmentId: department?.id ?? null, employeeCode };
  }

  private async department(tx: Tx, legalEntityId: number, codePrefix: string, lock = false) {
    const department = await this.repo.findDepartment(tx, legalEntityId, codePrefix, lock);
    if (!department) throw new AppError('HRMS_UNKNOWN_DEPARTMENT', 400, `Unknown department ${codePrefix} in this company`);
    return department;
  }

  /**
   * own: only yourself. team: yourself plus people whose active job lists you as manager; with team scope you may
   * view yourself but not change yourself (nobody changes their own job). all: everyone in the tenant.
   */
  private async checkScope(conn: Conn, ctx: RequestContext, permission: string, personId: number): Promise<void> {
    const scope = ctx.permissions[permission];
    if (scope === 'all') return;
    if (scope === 'own' && personId === ctx.personId) return;
    if (scope === 'team') {
      if (personId === ctx.personId ? permission === PEOPLE.view : await this.repo.managesPerson(conn, ctx.personId, personId)) return;
    }
    throw new AppError('FORBIDDEN', 403, 'This person is outside what you may see or change');
  }

  private async personId(conn: Conn, tenantId: number, publicId: string): Promise<number> {
    const id = await this.repo.findPersonId(conn, tenantId, publicId);
    if (!id) throw new AppError('HRMS_PERSON_NOT_FOUND', 404, 'Person not found');
    return id;
  }

  private async managerId(tx: Tx, tenantId: number, publicId: string): Promise<number> {
    const id = await this.repo.findPersonId(tx, tenantId, publicId);
    if (!id) throw new AppError('HRMS_MANAGER_NOT_FOUND', 400, 'Manager not found');
    return id;
  }

  private async employment(tx: Tx, tenantId: number, publicId: string) {
    const job = await this.repo.findEmployment(tx, tenantId, publicId);
    if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
    return job;
  }

  private employmentRow(tenantId: number, personId: number, e: EmploymentInput, refs: EmploymentRefs) {
    return {
      tenantId, personId, ...refs, employmentType: e.engagementType, status: e.status,
      recruitedOn: e.recruitedOn, joinedOn: e.joinedOn, designation: e.designation,
    };
  }
}

interface EmploymentRefs { legalEntityId: number; managerPersonId: number | null; departmentId: number | null; employeeCode: string }
