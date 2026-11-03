import { Module } from '@nestjs/common';
import { SkillsController } from './api/skills.controller';
import { SkillsService } from './application/skills.service';
import { SkillsRepository } from './infrastructure/skills.repository';

@Module({ controllers: [SkillsController], providers: [SkillsService, SkillsRepository], exports: [SkillsService] })
export class SkillsModule {}
