import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RecordStatus, CategoriesQuery, Category, CreateCategoryRequest, UpdateCategoryRequest } from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CoreFacade } from '../../core/core.facade';
import { itemCategories } from '../schema';
import { CatalogRepository, CategoryRow } from '../infrastructure/catalog.repository';
import { INVENTORY, INVENTORY_READ } from '../domain/permissions';
import { CompanyAccess } from './company-access.service';
import { isResentCreate, personRef } from './support';

/**
 * Each company's item categories. Name (ignoring case) and code prefix are unique per company; the prefix never changes
 * because item codes were made from it. Inactive categories take no new items; their items keep them.
 */
@Injectable()
export class CategoriesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CatalogRepository) private readonly repo: CatalogRepository,
    @Inject(CompanyAccess) private readonly access: CompanyAccess,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  async list(ctx: RequestContext, q: CategoriesQuery): Promise<Category[]> {
    const companies = await this.access.forList(ctx, INVENTORY_READ, q.company);
    return (await this.repo.listCategories(ctx.tenantId, companies.map((c) => c.id), q.status)).map(toCategory);
  }

  async get(ctx: RequestContext, publicId: string): Promise<Category> {
    return toCategory(await this.visible(this.db, ctx, publicId));
  }

  /** The same publicId again answers the stored category (created: false). */
  async create(ctx: RequestContext, req: CreateCategoryRequest): Promise<{ category: Category; created: boolean }> {
    if (await this.access.alreadyStored(ctx, itemCategories, req.publicId)) return { category: await this.get(ctx, req.publicId as string), created: false };
    const company = await this.access.require(ctx, [INVENTORY.items], req.company);
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.insertCategory(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: company.id, name: req.name, codePrefix: req.codePrefix,
          createdBy: ctx.personId });
        await this.audit(tx, ctx, 'inventory.category.created', publicId, company.id, `Added item category ${req.name} (${req.codePrefix}) to ${company.code}`,
          { codePrefix: req.codePrefix });
      });
    } catch (err) {
      if (isResentCreate(err)) return { category: await this.get(ctx, publicId), created: false };
      throw refuse(err) ?? err;
    }
    return { category: await this.get(ctx, publicId), created: true };
  }

  /** Sending what is already stored changes nothing. */
  async update(ctx: RequestContext, publicId: string, req: UpdateCategoryRequest): Promise<Category> {
    try {
      return await this.db.transaction(async (tx) => {
        const category = await this.visible(tx, ctx, publicId, true);
        await this.access.requireChange(ctx, INVENTORY.items, category.legalEntityId, category.company);
        const patch: { name?: string; status?: RecordStatus } = {};
        if (req.name !== undefined && req.name !== category.name) patch.name = req.name;
        if (req.status !== undefined && req.status !== category.status) patch.status = req.status;
        const changed = Object.keys(patch);
        if (changed.length === 0) return toCategory(category);
        await this.repo.updateCategory(tx, category.id, patch);
        const [action, verb] = changed.length === 1 && patch.status !== undefined
          ? (patch.status === 'active' ? ['inventory.category.reactivated', 'Reactivated'] : ['inventory.category.deactivated', 'Deactivated'])
          : ['inventory.category.updated', 'Changed'];
        await this.audit(tx, ctx, action, publicId, category.legalEntityId, `${verb} item category ${patch.name ?? category.name} of ${category.company}`,
          { codePrefix: category.codePrefix, changed, ...patch });
        return toCategory(await this.visible(tx, ctx, publicId));
      });
    } catch (err) {
      throw refuse(err) ?? err;
    }
  }

  /** A category of a company the caller reaches; anything else is unknown (404). */
  private async visible(conn: Conn, ctx: RequestContext, publicId: string, lock = false): Promise<CategoryRow> {
    const row = await this.repo.category(conn, ctx.tenantId, publicId, lock);
    if (!row || !(await this.access.mayUse(ctx, INVENTORY_READ, row.legalEntityId))) throw new AppError('INVENTORY_CATEGORY_NOT_FOUND', 404, 'Unknown item category');
    return row;
  }

  private audit(tx: Tx, ctx: RequestContext, action: string, publicId: string, legalEntityId: number, summary: string, details: Record<string, unknown>) {
    return this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action, entity: 'inventory_category', entityPublicId: publicId, legalEntityId, summary, details });
  }
}

function refuse(err: unknown): AppError | undefined {
  switch (violatedConstraint(err)) {
    case 'item_categories_company_name_unique': return new AppError('INVENTORY_DUPLICATE_CATEGORY_NAME', 409, 'This company already has a category with that name');
    case 'item_categories_company_prefix_unique': return new AppError('INVENTORY_DUPLICATE_CATEGORY_PREFIX', 409, 'This company already has a category with that code prefix');
    default: return undefined;
  }
}

function toCategory(r: CategoryRow): Category {
  return { publicId: r.publicId, company: r.company, name: r.name, codePrefix: r.codePrefix, status: r.status, itemCount: r.itemCount,
    createdBy: personRef(r.createdByPublicId, r.createdByName), createdAt: r.createdAt.toISOString() };
}
