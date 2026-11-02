import { EventEnvelope } from '../events/envelope';

export type LeaveApproved = EventEnvelope<'hrms.leave.approved', {
  personPublicId: string; leaveType: string; fromDate: string; toDate: string; days: number;
}>;
export type WorkdayValidated = EventEnvelope<'hrms.workday.validated', {
  personPublicId: string; workDate: string; status: string; workedMinutes: number; overtimeMinutes: number;
}>;
export type ExpenseApproved = EventEnvelope<'hrms.expense.approved', {
  personPublicId: string; amountPaise: number; approvedAmountPaise: number; ticketPublicId?: string;
}>;
