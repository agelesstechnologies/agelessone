/** What other modules may ask HRMS. Implemented by backend/src/modules/hrms/hrms.facade.ts */
export interface Availability { personPublicId: string; date: string; onLeave: boolean; verifiedSkills: string[]; ticketsThatDay: number; }
export interface HrmsFacadeContract {
  getAvailability(date: string, skillCode?: string): Promise<Availability[]>;
  isOnLeave(personPublicId: string, date: string): Promise<boolean>;
  getApprovedMinutes(personPublicId: string, from: string, to: string): Promise<number>;
}
