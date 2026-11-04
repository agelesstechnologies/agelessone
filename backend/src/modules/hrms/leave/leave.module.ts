import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { CalendarModule } from '../calendar/calendar.module';
import { LeaveController } from './api/leave.controller';
import { LeaveService } from './application/leave.service';
import { LeaveRepository } from './infrastructure/leave.repository';

@Module({ imports: [CalendarModule, AttendanceModule], controllers: [LeaveController], providers: [LeaveService, LeaveRepository], exports: [LeaveService] })
export class LeaveModule {}
