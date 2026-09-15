import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IProofAuditRepository } from "../../repositories/IProof-audit-repository";

import { UploadService } from "@/shared/services/upload-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { AppError } from "@/shared/errors/AppError";

import type {
  ListProofAuditsResult,
  ProofAuditStatus,
} from "../../dtos/proof-audit-dto";

interface ListProofAuditsRequest {
  userId: string;
  businessId?: string;

  status: ProofAuditStatus;

  page: number;
  pageSize: number;
}

/**
 * The receipts waiting for a person.
 *
 * Ordered so that the cards where a human adds the most value come first: a
 * photo the model could not read, then the ones it was least sure about, then
 * the clean confident ones a reviewer clears in a second. Sorting within the
 * page rather than in SQL because the priority is buried in a JSON column and
 * a page is fifty rows — an expression index to sort fifty rows would be
 * machinery paid for on every write.
 */
@injectable()
class ListProofAuditsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ProofAuditRepository")
    private audits: IProofAuditRepository,
    @inject("UploadService")
    private uploads: UploadService,
  ) {}

  async execute({
    userId,
    businessId,
    status,
    page,
    pageSize,
  }: ListProofAuditsRequest): Promise<ListProofAuditsResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw new ResourceNotFoundError();

    // Auditing receipts is the office's job. A driver reviewing their own
    // proof is the one reviewer whose verdict means nothing.
    assertDispatcher(findUser);

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    const result = await this.audits.listQueue({
      businessId: resolvedBusinessId,
      status,
      page,
      pageSize,
    });

    const data = await Promise.all(
      result.data
        .slice()
        .sort(
          (left, right) =>
            (left.ai_suggestion?.assessment.reviewPriority ?? 0) -
            (right.ai_suggestion?.assessment.reviewPriority ?? 0),
        )
        .map(async (card) => ({
          ...card,

          // Signed here rather than in the repository: the signing service is
          // an I/O concern and the repository's job is the rows.
          photoUrl: card.photoUrl
            ? await this.uploads.getFileUrl(card.photoUrl)
            : null,
          signatureUrl: card.signatureUrl
            ? await this.uploads.getFileUrl(card.signatureUrl)
            : null,
        })),
    );

    return { ...result, data };
  }
}

export { ListProofAuditsUseCase };
