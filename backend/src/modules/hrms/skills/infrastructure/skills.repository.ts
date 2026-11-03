import { Inject, Injectable } from '@nestjs/common';
import { DB, Db } from '../../../../platform/db/db.module';

/** Touches only hrms.* tables. */
@Injectable()
export class SkillsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}
}
