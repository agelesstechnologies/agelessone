import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { LeaveModule } from '../leave/leave.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { ReportsController } from './api/reports.controller';
import { DashboardController } from './api/dashboard.controller';
import { ReportsService } from './application/reports.service';
import { ApprovalsInboxService } from './application/approvals-inbox.service';
import { DashboardService } from './application/dashboard.service';
import { ReportsRepository } from './infrastructure/reports.repository';

@Module({
  imports: [CalendarModule, AttendanceModule, LeaveModule, ExpensesModule],
  controllers: [ReportsController, DashboardController],
  providers: [ReportsService, ReportsRepository, ApprovalsInboxService, DashboardService],
  exports: [ReportsService],
})
export class ReportsModule {}
