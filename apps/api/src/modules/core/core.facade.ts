import { Injectable } from '@nestjs/common';
/** The only Core entry point other modules may use. */
@Injectable()
export class CoreFacade {
  /** Newest version of a policy in force on a date, most specific scope first. */
  async getPolicy<T>(key: string, _scope: { branchId?: number; departmentId?: number }, _onDate: string, fallback: T): Promise<T> {
    return fallback; // replaced by a real lookup on core.policies in Sprint 2
  }
}
