import { Module } from '@nestjs/common';
import { PeopleModule } from './people/people.module';
import { SkillsModule } from './skills/skills.module';
import { AttendanceModule } from './attendance/attendance.module';
import { LeaveModule } from './leave/leave.module';
import { ExpensesModule } from './expenses/expenses.module';
import { ReportsModule } from './reports/reports.module';
import { HrmsFacade } from './hrms.facade';

/** HRMS: six sub-modules, one public facade. */
@Module({
  imports: [PeopleModule, SkillsModule, AttendanceModule, LeaveModule, ExpensesModule, ReportsModule],
  providers: [HrmsFacade],
  exports: [HrmsFacade],
})
export class HrmsModule {}
