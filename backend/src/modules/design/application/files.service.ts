import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../platform/http/app-error';
import { todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { designFileType, FilePurpose } from '../domain/files';

/** An uploaded file as multer keeps it in memory (the uploaded name is only used for its extension). */
export interface Upload { buffer: Buffer; size: number; originalname?: string }

/** The hard limit of one upload; policy design.max_file_mb sets the real one (at most this). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Checks uploads: there is one, it is not larger than policy design.max_file_mb, and its bytes are of an accepted type. */
@Injectable()
export class DesignFiles {
  constructor(@Inject(CoreFacade) private readonly core: CoreFacade) {}

  /** The extension the file is stored as. */
  async accept(tenantId: number, companyId: number, file: Upload | undefined, purpose: FilePurpose): Promise<string> {
    if (!file || file.size === 0) throw new AppError('DESIGN_FILE_REQUIRED', 400, 'Attach the file (field `file`)');
    const maxMb = await this.core.getPolicy(tenantId, 'design.max_file_mb', companyId, todayIst());
    if (file.size > maxMb * 1024 * 1024) throw new AppError('DESIGN_FILE_TOO_LARGE', 413, `Files of up to ${maxMb} MB are accepted (policy design.max_file_mb)`);
    const type = designFileType(file.buffer, file.originalname, purpose);
    if ('problem' in type) throw new AppError('DESIGN_FILE_TYPE', 400, type.problem);
    return type.ext;
  }
}
