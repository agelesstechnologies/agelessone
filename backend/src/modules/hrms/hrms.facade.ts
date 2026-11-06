import { Inject, Injectable } from '@nestjs/common';
import { Availability, HrmsFacadeContract } from '@ageless/shared';
import { Conn } from '../../platform/db/db.module';
import { AttendanceService, DayListener, PunchListener } from './attendance/application/attendance.service';
import { LeaveService } from './leave/application/leave.service';

/** The only HRMS entry point other modules may use. */
@Injectable()
export class HrmsFacade implements HrmsFacadeContract {
  constructor(
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
    @Inject(LeaveService) private readonly leave: LeaveService,
  ) {}

  /** Follow work-day changes (punches, corrections, leave, rebuilds), inside their transaction. */
  onWorkDayChanged(listener: DayListener): void { this.attendance.onDayChanged(listener); }

  /** Add notices to the answer of a new punch (e.g. tickets without today's update at punch-out). */
  onPunchStored(listener: PunchListener): void { this.attendance.onPunchStored(listener); }

  /** The person's latest punch that counts (any job); undefined if none. */
  latestPunch(conn: Conn, personId: number) { return this.attendance.latestPunchOf(conn, personId); }

  /** The person's attended periods (complete in/out pairs) on an IST date and their minutes. */
  attendedPeriods(conn: Conn, personId: number, date: string) { return this.attendance.attendedPeriods(conn, personId, date); }

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
