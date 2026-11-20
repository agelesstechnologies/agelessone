import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CreateCustomerRequest, Customer, CustomersQuery, UpdateCustomerRequest } from '@ageless/shared';
import { Conn, DB, Db, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext, requireAll } from '../../../../platform/http/request-context';
import { AuditService } from '../../audit/audit.service';
import { CustomerRow, CustomersRepository } from '../infrastructure/customers.repository';

/** Adds and changes customers: Admin user, System admin, Management (scope all). */
export const MANAGE_CUSTOMERS = 'core.customers.manage';

/**
 * The Core customer list. Anyone signed in may read it (names and codes only); core.customers.manage (scope all) adds
 * and changes customers. A group company becomes a customer linked to it (one customer per company). Audited.
 */
@Injectable()
export class CustomersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CustomersRepository) private readonly repo: CustomersRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(ctx: RequestContext, q: CustomersQuery): Promise<Customer[]> {
    return (await this.repo.list(this.db, ctx.tenantId, q)).map(toCustomer);
  }

  /** A new customer. The same publicId again: the stored customer (200). */
  async create(ctx: RequestContext, req: CreateCustomerRequest): Promise<{ customer: Customer; created: boolean }> {
    requireAll(ctx, MANAGE_CUSTOMERS);
    const publicId = req.publicId ?? randomUUID();
    if (req.publicId) {
      const found = await this.repo.byPublicId(this.db, req.publicId);
      if (found && found.tenantId === ctx.tenantId) return { customer: toCustomer(found), created: false };
      if (found) throw new AppError('CUSTOMER_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const company = req.company ? await this.repo.company(this.db, ctx.tenantId, req.company) : undefined;
    if (req.company && !company) throw new AppError('CUSTOMER_UNKNOWN_COMPANY', 400, `Unknown company ${req.company}`);
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.insert(tx, { tenantId: ctx.tenantId, publicId, code: req.code, name: req.name, legalEntityId: company?.id ?? null, createdBy: ctx.personId });
        await this.audit.write(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'core.customer_added', entity: 'customer', entityPublicId: publicId,
          legalEntityId: company?.id ?? null, summary: `Customer ${req.code} (${req.name}) added${company ? `: the group company ${company.code}` : ''}`,
          details: { code: req.code, name: req.name, company: company?.code ?? null } });
      });
    } catch (err) {
      const hit = violatedConstraint(err);
      if (hit === 'customers_tenant_code_unique') throw new AppError('CUSTOMER_DUPLICATE_CODE', 409, `A customer with code ${req.code} already exists`);
      if (hit === 'customers_one_per_company') throw new AppError('CUSTOMER_COMPANY_TAKEN', 409, `${req.company} is already a customer`);
      if (hit === 'customers_public_id_unique') return this.create(ctx, req);
      throw err;
    }
    return { customer: toCustomer((await this.repo.byPublicId(this.db, publicId))!), created: true };
  }

  /** The name, or active / inactive (an inactive customer takes no new design jobs). */
  async update(ctx: RequestContext, publicId: string, req: UpdateCustomerRequest): Promise<Customer> {
    requireAll(ctx, MANAGE_CUSTOMERS);
    const c = await this.find(this.db, ctx, publicId);
    const patch = { ...(req.name !== undefined && { name: req.name }), ...(req.status !== undefined && { status: req.status }) };
    if (Object.entries(patch).every(([k, v]) => c[k as keyof CustomerRow] === v)) return toCustomer(c);
    await this.db.transaction(async (tx) => {
      await this.repo.update(tx, c.id, { ...patch, updatedBy: ctx.personId, updatedAt: new Date() });
      await this.audit.write(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'core.customer_changed', entity: 'customer', entityPublicId: publicId,
        legalEntityId: c.legalEntityId, summary: `Customer ${c.code} changed`, details: { before: { name: c.name, status: c.status }, after: patch } });
    });
    return toCustomer((await this.repo.byPublicId(this.db, publicId))!);
  }

  private async find(conn: Conn, ctx: RequestContext, publicId: string): Promise<CustomerRow> {
    const c = await this.repo.byPublicId(conn, publicId);
    if (!c || c.tenantId !== ctx.tenantId) throw new AppError('CUSTOMER_NOT_FOUND', 404, 'Customer not found');
    return c;
  }
}

const toCustomer = (c: CustomerRow): Customer => ({
  publicId: c.publicId, code: c.code, name: c.name, company: c.company, status: c.status as Customer['status'], createdAt: c.createdAt.toISOString(),
});
