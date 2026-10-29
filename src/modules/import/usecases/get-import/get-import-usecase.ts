import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IImportRepository } from "../../repositories/IImport-repository";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { ImportNotFoundError } from "../errors/import-errors";
import { reversalView } from "../../services/import-reversal";

import type { ImportDetail } from "../../dtos/import-dto";

interface GetImportRequest {
  userId: string;
  businessId: string;
  importId: string;
}

/**
 * One upload, with its per-row report.
 *
 * The report is what "qual das duzentas falhou?" is answered from, and it is
 * one entry per spreadsheet line. It is read here, one upload at a time, when
 * the operator opens it — not carried by every row of the history listing,
 * where a page of big days held megabytes in memory to draw four numbers.
 */
@injectable()
class GetImportUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ImportRepository")
    private importRepository: IImportRepository,
  ) {}

  async execute({
    userId,
    businessId,
    importId,
  }: GetImportRequest): Promise<ImportDetail> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw callerNotFound();

    assertTenantAccess(findUser, businessId);

    const found = await this.importRepository.findImportById(
      importId,
      businessId,
    );

    // Scoped by company in the read itself, so another carrier's upload
    // reads as absent, never as "exists but is not yours".
    if (!found) {
      throw new ImportNotFoundError();
    }

    // The undo of a big upload runs after its answer (202): this is where the
    // client follows it — RUNNING, INTERRUPTED (asking again resumes it) or
    // DONE with the result. The lease and the heartbeat stay internal.
    const {
      reversal: _progress,
      reversal_started_at: _lease,
      updated_at: _heartbeat,
      ...rest
    } = found;

    return { ...rest, reversal: reversalView(found) };
  }
}

export { GetImportUseCase };
