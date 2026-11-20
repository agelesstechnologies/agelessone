import { Module } from '@nestjs/common';
import { DesignJobsController } from './api/jobs.controller';
import { DrawingsController } from './api/drawings.controller';
import { TransmittalsController } from './api/transmittals.controller';
import { DesignReportsController } from './api/reports.controller';
import { DesignAccess } from './application/access.service';
import { DesignFiles } from './application/files.service';
import { DesignJobsService } from './application/jobs.service';
import { DrawingsService } from './application/drawings.service';
import { QcService } from './application/qc.service';
import { TransmittalsService } from './application/transmittals.service';
import { DesignReportsService } from './application/reports.service';
import { DesignRepository } from './infrastructure/design.repository';
import { DesignReportsRepository } from './infrastructure/reports.repository';

/**
 * Design (Ageless Technologies): design jobs from clients (Core customers; AE is one), their tickets, drawings and
 * revisions, QC, transmittals with cover sheets and zips, client responses and reports. A job whose client is another
 * group company makes its tickets billable through IntercompanyFacade. Reads core, hrms, tickets and intercompany
 * through their schema.ts; writes only design.*. Guide: docs/api/design.md.
 */
@Module({
  controllers: [DesignJobsController, DrawingsController, TransmittalsController, DesignReportsController],
  providers: [DesignAccess, DesignFiles, DesignJobsService, DrawingsService, QcService, TransmittalsService, DesignReportsService, DesignRepository, DesignReportsRepository],
})
export class DesignModule {}
