import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { AttendanceController } from './api/attendance.controller';
import { CorrectionsController } from './api/corrections.controller';
import { OvertimeController } from './api/overtime.controller';
import { MonthLocksController } from './api/month-locks.controller';
import { AttendanceService } from './application/attendance.service';
import { CorrectionsService } from './application/corrections.service';
import { OvertimeService } from './application/overtime.service';
import { MonthLocksService } from './application/month-locks.service';
import { AttendanceRepository } from './infrastructure/attendance.repository';
import { CorrectionsRepository } from './infrastructure/corrections.repository';
import { OvertimeRepository } from './infrastructure/overtime.repository';
import { MonthLocksRepository } from './infrastructure/month-locks.repository';

@Module({
  imports: [CalendarModule],
  controllers: [AttendanceController, CorrectionsController, OvertimeController, MonthLocksController],
  providers: [AttendanceService, AttendanceRepository, CorrectionsService, CorrectionsRepository, OvertimeService, OvertimeRepository,
    MonthLocksService, MonthLocksRepository],
  exports: [AttendanceService, MonthLocksService, CorrectionsService, OvertimeService],
})
export class AttendanceModule {}
