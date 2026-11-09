import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import {
  CreateDepartmentRequest, CreatePositionRequest, Department, DepartmentsQuery, Designation, DesignationsQuery, FillPositionRequest, NextEmployeeCode, Position, PositionsQuery, PositionStatusRequest, UpdateDepartmentRequest,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, MANAGEMENT, Permission, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { OrganisationService } from '../application/organisation.service';
import { PEOPLE } from '../domain/permissions';
import { PublicIdParam } from './people.controller';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms')
export class OrganisationController {
  constructor(@Inject(OrganisationService) private readonly service: OrganisationService) {}

  @Doc({ summary: 'Departments of a company, with heads', response: z.array(Department) })
  @SignedIn() @Get('departments')
  departments(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(DepartmentsQuery)) q: DepartmentsQuery) {
    return this.service.departments(ctx, q);
  }

  @Doc({ summary: 'The employee code the next person in this department would get (ATS004 …); reserved only when the job is saved', response: NextEmployeeCode })
  @Permission(PEOPLE.create, PEOPLE.manageEmployments) @Get('departments/:publicId/next-employee-code')
  nextEmployeeCode(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.nextEmployeeCode(ctx, publicId);
  }

  @Doc({ summary: 'Add a department (name and employee-code prefix)', response: Department })
  @Permission(PEOPLE.manageEmployments) @Post('departments')
  createDepartment(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateDepartmentRequest)) body: CreateDepartmentRequest) {
    return this.service.createDepartment(ctx, body);
  }

  @Doc({ summary: 'Rename a department or set its head', response: Department })
  @Permission(PEOPLE.manageEmployments) @Patch('departments/:publicId')
  updateDepartment(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(UpdateDepartmentRequest)) body: UpdateDepartmentRequest) {
    return this.service.updateDepartment(ctx, publicId, body);
  }

  @Doc({ summary: 'Designations of a company', response: z.array(Designation) })
  @SignedIn() @Get('designations')
  designations(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(DesignationsQuery)) q: DesignationsQuery) {
    return this.service.designations(ctx, q);
  }

  @Doc({ summary: 'Positions (planned, open, filled)', response: z.array(Position) })
  @Permission(PEOPLE.managePositions, MANAGEMENT) @Get('positions')
  positions(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PositionsQuery)) q: PositionsQuery) {
    return this.service.positions(ctx, q);
  }

  /** 201 new; 200 with the stored position when the same publicId is sent again. */
  @Doc({ summary: 'Plan or open a position in a department', response: Position, resend: true })
  @Permission(PEOPLE.managePositions) @Post('positions')
  async createPosition(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreatePositionRequest)) body: CreatePositionRequest,
    @Res({ passthrough: true }) res: { status(code: number): void }) {
    const { position, created } = await this.service.createPosition(ctx, body);
    if (!created) res.status(200);
    return position;
  }

  @Doc({ summary: 'Move a position between planned and open', response: Position })
  @Permission(PEOPLE.managePositions) @Post('positions/:publicId/status') @HttpCode(200)
  setStatus(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(PositionStatusRequest)) body: PositionStatusRequest) {
    return this.service.setPositionStatus(ctx, publicId, body);
  }

  @Doc({ summary: 'Fill a position with the hired person\'s employment', response: Position })
  @Permission(PEOPLE.managePositions) @Post('positions/:publicId/fill') @HttpCode(200)
  fill(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(FillPositionRequest)) body: FillPositionRequest) {
    return this.service.fillPosition(ctx, publicId, body);
  }
}
