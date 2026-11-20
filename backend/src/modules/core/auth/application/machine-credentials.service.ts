import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { CreateMachineCredentialRequest, CreatedMachineCredential, MachineCredential } from '@ageless/shared';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext, requireAll } from '../../../../platform/http/request-context';
import { DB, Db } from '../../../../platform/db/db.module';
import { CoreFacade } from '../../core.facade';
import { AuthRepository } from '../infrastructure/auth.repository';
import { BCRYPT_ROUNDS } from './auth.service';

const MANAGE = 'core.users.manage';
type Row = Awaited<ReturnType<AuthRepository['findMachineByClientId']>> & object;
const toCredential = (r: Row): MachineCredential => ({
  publicId: r.publicId, name: r.name, clientId: r.clientId, permission: r.permission, isActive: r.isActive,
  createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null, revokedAt: r.revokedAt?.toISOString() ?? null,
});

/**
 * Machine credentials for programs such as the Tally connector. An admin (core.users.manage, scope all) makes one; the secret
 * is shown once and only its bcrypt hash is kept. Revoking works at once (the guard checks the credential on every request).
 */
@Injectable()
export class MachineCredentialsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuthRepository) private readonly repo: AuthRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  async create(ctx: RequestContext, req: CreateMachineCredentialRequest): Promise<CreatedMachineCredential> {
    requireAll(ctx, MANAGE);
    const clientId = `mc_${randomBytes(12).toString('base64url')}`;
    const secret = `mcs_${randomBytes(32).toString('base64url')}`;
    const row = await this.repo.insertMachine({ tenantId: ctx.tenantId, name: req.name, clientId, secretHash: await bcrypt.hash(secret, BCRYPT_ROUNDS),
      permission: req.permission, createdBy: ctx.personId });
    await this.db.transaction((tx) => this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'core.machine_credential_created',
      entity: 'machine_credential', entityPublicId: row.publicId, summary: `Made the machine credential "${req.name}" (${req.permission})` }));
    return { ...toCredential(row), secret };
  }

  async list(ctx: RequestContext): Promise<MachineCredential[]> {
    requireAll(ctx, MANAGE);
    return (await this.repo.listMachines(ctx.tenantId)).map(toCredential);
  }

  /** Stops the credential at once. Revoking a revoked one changes nothing. */
  async revoke(ctx: RequestContext, publicId: string): Promise<MachineCredential> {
    requireAll(ctx, MANAGE);
    const cred = await this.repo.findMachine(ctx.tenantId, publicId);
    if (!cred) throw new AppError('NOT_FOUND', 404, 'No such machine credential');
    if (cred.isActive) {
      await this.repo.revokeMachine(cred.id);
      await this.db.transaction((tx) => this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'core.machine_credential_revoked',
        entity: 'machine_credential', entityPublicId: publicId, summary: `Revoked the machine credential "${cred.name}"` }));
    }
    return toCredential((await this.repo.findMachine(ctx.tenantId, publicId))!);
  }
}
