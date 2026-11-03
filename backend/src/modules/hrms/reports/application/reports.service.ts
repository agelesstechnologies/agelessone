import { Inject, Injectable } from '@nestjs/common';
import { ReportsRepository } from '../infrastructure/reports.repository';

/** Use cases live here: open the transaction, call repositories and other facades, write the outbox event. */
@Injectable()
export class ReportsService {
  constructor(@Inject(ReportsRepository) private readonly repo: ReportsRepository) {}
  health() { return { module: 'hrms', sub: 'reports', ok: true }; }
}
