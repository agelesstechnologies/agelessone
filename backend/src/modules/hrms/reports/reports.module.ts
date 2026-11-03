import { Module } from '@nestjs/common';
import { ReportsController } from './api/reports.controller';
import { ReportsService } from './application/reports.service';
import { ReportsRepository } from './infrastructure/reports.repository';

@Module({ controllers: [ReportsController], providers: [ReportsService, ReportsRepository], exports: [ReportsService] })
export class ReportsModule {}
