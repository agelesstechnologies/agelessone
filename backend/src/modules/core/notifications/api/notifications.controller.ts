import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { NotificationList, NotificationPreferences, NotificationsMarked, NotificationsQuery, SaveNotificationPreferencesRequest } from '@ageless/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { NotificationPreferencesService } from '../application/notification-preferences.service';
import { NotificationsService } from '../application/notifications.service';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());

/** Everyone sees only their own alerts. */
@Controller('core/notifications')
export class NotificationsController {
  constructor(
    @Inject(NotificationsService) private readonly service: NotificationsService,
    @Inject(NotificationPreferencesService) private readonly preferences: NotificationPreferencesService,
  ) {}

  @Doc({ summary: 'My alert email choices: instant and morning emails, quiet hours, and email per type of alert', response: NotificationPreferences, description: 'Any signed-in person; only their own. The bell is always on.' })
  @SignedIn() @Get('preferences')
  getPreferences(@Ctx() ctx: RequestContext) { return this.preferences.get(ctx); }

  @Doc({ summary: 'Save my alert email choices (types not named keep their choice)', response: NotificationPreferences, description: 'Any signed-in person; only their own.' })
  @SignedIn() @Put('preferences')
  savePreferences(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(SaveNotificationPreferencesRequest)) body: SaveNotificationPreferencesRequest) {
    return this.preferences.save(ctx, body);
  }

  @Doc({ summary: 'My alerts (newest first) and how many are unread', response: NotificationList, description: 'Any signed-in person; only their own.' })
  @SignedIn() @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(NotificationsQuery)) q: NotificationsQuery) { return this.service.list(ctx, q); }

  @Doc({ summary: 'Mark all my alerts read', response: NotificationsMarked, description: 'Any signed-in person; only their own.' })
  @SignedIn() @Post('read-all') @HttpCode(200)
  readAll(@Ctx() ctx: RequestContext) { return this.service.markAllRead(ctx); }

  @Doc({ summary: 'Mark one of my alerts read', response: NotificationsMarked, description: 'Any signed-in person; only their own.' })
  @SignedIn() @Post(':publicId/read') @HttpCode(200)
  read(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) { return this.service.markRead(ctx, publicId); }
}
