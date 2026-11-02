import { Injectable } from '@nestjs/common';
import { AttendanceRepository } from '../infrastructure/attendance.repository';

/** Use cases live here: open the transaction, call repositories and other facades, write the outbox event. */
@Injectable()
export class AttendanceService {
  constructor(private readonly repo: AttendanceRepository) {}
  health() { return { module: 'hrms', sub: 'attendance', ok: true }; }
}
