import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IProofAuditRepository } from "../../repositories/IProof-audit-repository";

import { UploadService } from "@/shared/services/upload-service";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { AppError } from "@/shared/errors/AppError";
import { businessDaysRange, resolveTimeZone } from "@/shared/time/business-day";

import { proofAiState } from "./proof-ai-state";
import { proofDeviceAgreement } from "@/shared/ai-precheck/device-precheck";

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
 * The agreement rate covers the decisions of this many calendar days, today
 * included, counted in the company's zone (DLVB-04). The web labels the number
 * with it, from the meta.
 */
const AGREEMENT_WINDOW_DAYS = 90;

/**
 * The receipts waiting for a person, and the ones already decided.
 *
 * The queue is ordered so that the cards where a human adds the most value
 * come first: a photo the model could not read, then the ones it was least
 * sure about, then the clean confident ones a reviewer clears in a second.
 * The history tabs are ordered by the decision, newest first. Both orders are
 * the repository's, in SQL, so page 2 continues page 1: sorting inside a page
 * made pages overlap in priority and put a receipt approved now on the last
 * page of Aprovados, which the screen never asked for (DLVB-02).
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

    // The session was checked by the middleware; a user row gone since then
    // is a 404 with its code (decision 11.3), not a bare 400.
    if (!findUser) {
      throw new AppError("Usuário não encontrado.", 404, "USER_NOT_FOUND");
    }

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

    const settings = await this.audits.findQueueSettings(resolvedBusinessId);

    const now = new Date();

    // Civil days in the company's zone (decision 1.1), not the server's:
    // the window opens at midnight there.
    const agreementSince = businessDaysRange(
      now,
      resolveTimeZone(settings?.timezone),
      AGREEMENT_WINDOW_DAYS,
    ).start;

    const aiContracted = (settings?.ai_analysis_limit ?? 0) > 0;

    const result = await this.audits.listQueue({
      businessId: resolvedBusinessId,
      status,
      page,
      pageSize,
      agreementSince,
    });

    const data = await Promise.all(
      result.data.map(async (card) => ({
        ...card,

        aiState: proofAiState({
          hasSuggestion: card.ai_suggestion !== null,
          analysisStatus: card.analysisStatus,
          aiContracted,
          cardStatus: card.status,
          createdAt: card.created_at,
          hasDevicePrecheck: card.device_precheck != null,
          now,
        }),

        // The phone's check next to the server's reading (decision 14.2):
        // the verdict once stored, else compared here from the reading.
        deviceAgreement:
          card.device_agreement ??
          proofDeviceAgreement(card.device_precheck, card.ai_suggestion?.reading),

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

    return {
      data,
      total: result.total,
      meta: { ...result.meta, agreementWindowDays: AGREEMENT_WINDOW_DAYS },
    };
  }
}

export { AGREEMENT_WINDOW_DAYS, ListProofAuditsUseCase };
