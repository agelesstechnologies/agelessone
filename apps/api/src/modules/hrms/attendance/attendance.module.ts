import { Module } from '@nestjs/common';
import { AttendanceController } from './api/attendance.controller';
import { AttendanceService } from './application/attendance.service';
import { AttendanceRepository } from './infrastructure/attendance.repository';

@Module({ controllers: [AttendanceController], providers: [AttendanceService, AttendanceRepository], exports: [AttendanceService] })
export class AttendanceModule {}
