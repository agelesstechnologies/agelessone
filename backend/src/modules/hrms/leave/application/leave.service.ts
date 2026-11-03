import { Inject, Injectable } from '@nestjs/common';
import { LeaveRepository } from '../infrastructure/leave.repository';

/** Use cases live here: open the transaction, call repositories and other facades, write the outbox event. */
@Injectable()
export class LeaveService {
  constructor(@Inject(LeaveRepository) private readonly repo: LeaveRepository) {}
  health() { return { module: 'hrms', sub: 'leave', ok: true }; }
}
