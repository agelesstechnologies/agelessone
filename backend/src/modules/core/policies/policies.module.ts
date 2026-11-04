import { Module } from '@nestjs/common';
import { PoliciesController } from './api/policies.controller';
import { PolicyService } from './application/policy.service';
import { PoliciesRepository } from './infrastructure/policies.repository';

/** Company policies, versioned and append-only. */
@Module({ controllers: [PoliciesController], providers: [PolicyService, PoliciesRepository], exports: [PolicyService] })
export class PoliciesModule {}
