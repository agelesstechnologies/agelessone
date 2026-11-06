import { Inject, Injectable } from '@nestjs/common';
import { Availability, HrmsFacadeContract } from '@ageless/shared';
import { AttendanceService } from './attendance/application/attendance.service';
import { LeaveService } from './leave/application/leave.service';

/** The only HRMS entry point other modules may use. */
@Injectable()
export class HrmsFacade implements HrmsFacadeContract {
  constructor(
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
    @Inject(LeaveService) private readonly leave: LeaveService,
  ) {}

  async getAvailability(_date: string, _skillCode?: string): Promise<Availability[]> { return []; }
  async isOnLeave(_personPublicId: string, _date: string): Promise<boolean> { return false; }
  async getApprovedMinutes(_personPublicId: string, _from: string, _to: string): Promise<number> { return 0; }

  /**
   * For payroll: absent days per job of a company over a period (by employment public id) — the work-hours absent days
   * (absences, half days, past working days with nothing recorded) plus approved leave of unpaid types.
   */
  async absentDaysForPayroll(tenantId: number, company: string, from: string, to: string): Promise<Record<string, number>> {
    const hours = await this.attendance.hoursOf(tenantId, { company, from, to }, { scope: 'all' });
    const unpaid = await this.leave.unpaidDaysIn(tenantId, company, from, to);
    const out: Record<string, number> = {};
    for (const r of hours.rows) out[r.employment.publicId] = r.absentDays;
    for (const [job, days] of unpaid) out[job] = (out[job] ?? 0) + days;
    return out;
  }
}
