import { Module } from '@nestjs/common';
import { CalendarController } from './api/calendar.controller';
import { CalendarService } from './application/calendar.service';
import { CalendarRepository } from './infrastructure/calendar.repository';

@Module({ controllers: [CalendarController], providers: [CalendarService, CalendarRepository], exports: [CalendarService] })
export class CalendarModule {}
