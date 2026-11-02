import { Injectable } from '@nestjs/common';
import { Availability, HrmsFacadeContract } from '@ageless/core-contracts';

/** The only HRMS entry point other modules may use. */
@Injectable()
export class HrmsFacade implements HrmsFacadeContract {
  async getAvailability(_date: string, _skillCode?: string): Promise<Availability[]> { return []; }
  async isOnLeave(_personPublicId: string, _date: string): Promise<boolean> { return false; }
  async getApprovedMinutes(_personPublicId: string, _from: string, _to: string): Promise<number> { return 0; }
}
