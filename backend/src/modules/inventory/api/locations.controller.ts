import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { CreateLocationRequest, ImportCsvRequest, ImportResult, Location, LocationsQuery, UpdateLocationRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { LocationsService } from '../application/locations.service';
import { LocationImportService } from '../application/location-import.service';
import { CsvUpload, MAX_CSV_BYTES } from '../application/csv-upload';
import { INVENTORY, INVENTORY_READ } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
const COMPANIES = 'Only companies the caller works in (scope all: every company); another company\'s locations are unknown (404).';
const PLACEMENT = 'A rack goes inside a store, a bin inside a store or a rack; other types stand on their own (400 INVENTORY_LOCATION_PLACEMENT). '
  + 'The custodian has a current job in the same company; racks and bins may leave it to their parent.';

/** Only: validate input, check permission, call one use case. Fixed paths (import) come before /:publicId. */
@Controller('inventory/locations')
export class LocationsController {
  constructor(
    @Inject(LocationsService) private readonly service: LocationsService,
    @Inject(LocationImportService) private readonly importer: LocationImportService,
  ) {}

  @Doc({ summary: 'Store locations of the companies you reach, with parent, custodian and who answers for each', response: z.array(Location), description: COMPANIES })
  @Permission(...INVENTORY_READ) @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(LocationsQuery)) q: LocationsQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'Import a company\'s store locations from a CSV file (duplicates by code skipped)', response: ImportResult, multipart: 'file',
    description: 'Columns (header row, any case): code, name, type, parent (the parent\'s code: an existing location or another row of the file), custodian '
      + '(employee code of a current job in the company). Rows whose code the company already uses, or an earlier row used, are skipped. Any other problem '
      + 'refuses the whole file: 400 INVENTORY_IMPORT_INVALID with details [{ row, field, message }]. Parents in the file are created first. '
      + `dryRun=true checks without saving. ${PLACEMENT}` })
  @Permission(INVENTORY.locations) @Post('import') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES, files: 1 } }))
  import(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ImportCsvRequest)) body: ImportCsvRequest, @UploadedFile() file: CsvUpload | undefined) {
    return this.importer.import(ctx, body, file);
  }

  @Doc({ summary: 'One store location', response: Location, description: COMPANIES })
  @Permission(...INVENTORY_READ) @Get(':publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Doc({ summary: 'Add a store location to a company', response: Location, resend: true,
    description: `Code unique per company. Type and parent never change. ${PLACEMENT} ${COMPANIES}` })
  @Permission(INVENTORY.locations) @Post()
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateLocationRequest)) body: CreateLocationRequest, @Res({ passthrough: true }) res: Created) {
    const { location, created } = await this.service.create(ctx, body);
    if (!created) res.status(200);
    return location;
  }

  @Doc({ summary: 'Rename a location, change its custodian or its status', response: Location,
    description: 'A location with active racks or bins inside cannot become inactive (409 INVENTORY_LOCATION_HAS_CHILDREN); a rack or bin becomes active only while its parent is.' })
  @Permission(INVENTORY.locations) @Patch(':publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(UpdateLocationRequest)) body: UpdateLocationRequest) {
    return this.service.update(ctx, publicId, body);
  }
}
