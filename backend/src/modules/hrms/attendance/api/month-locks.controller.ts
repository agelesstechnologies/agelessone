import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { LockMonthRequest, MonthLock, MonthLocksQuery, UnlockMonthRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { MonthLocksService } from '../application/month-locks.service';
import { ATTENDANCE } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/month-locks')
export class MonthLocksController {
  constructor(@Inject(MonthLocksService) private readonly service: MonthLocksService) {}

  /** HR or System Admin (checked by the service). */
  @Doc({ summary: 'Month locks, unlocked ones too (HR or System admin)', response: z.array(MonthLock) })
  @SignedIn() @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(MonthLocksQuery)) q: MonthLocksQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'Lock an ended month of a company: nothing in it can change any more', response: MonthLock })
  @Permission(ATTENDANCE.lockMonth) @Post()
  lock(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(LockMonthRequest)) body: LockMonthRequest) {
    return this.service.lock(ctx, body);
  }

  @Doc({ summary: 'Unlock with a reason (System admin); who, when and why are kept', response: MonthLock })
  @Permission(ATTENDANCE.unlockMonth) @Post(':publicId/unlock') @HttpCode(200)
  unlock(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(UnlockMonthRequest)) body: UnlockMonthRequest) {
    return this.service.unlock(ctx, publicId, body);
  }
}
