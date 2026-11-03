import { Inject, Injectable } from '@nestjs/common';
import { SkillsRepository } from '../infrastructure/skills.repository';

/** Use cases live here: open the transaction, call repositories and other facades, write the outbox event. */
@Injectable()
export class SkillsService {
  constructor(@Inject(SkillsRepository) private readonly repo: SkillsRepository) {}
  health() { return { module: 'hrms', sub: 'skills', ok: true }; }
}
