import { inject, injectable } from "tsyringe";

import type { IIntegrationRepository } from "../../repositories/IIntegration-repository";

import { GetProofDocumentUseCase } from "@/modules/delivery/usecases/get-proof-document/get-proof-document-usecase";

import {
  PROOF_LINK_STATUSES,
  proofLinkSigns,
  readProofLinkToken,
} from "@/shared/integration/proof-link";
import { AppError } from "@/shared/errors/AppError";
import { env } from "@/env";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One refusal for every link that does not open, as on /public/verify-proof:
 * a distinct "expired" or "not yours" would let somebody probe which
 * deliveries exist.
 */
function proofNotFound(): AppError {
  return new AppError("Comprovante não encontrado.", 404, "PROOF_NOT_FOUND");
}

/**
 * GET /public/delivery-proof/:token — the `proof_url` an integrator received
 * (plan of 02/11/2026, L7).
 *
 * The link names the delivery and is signed for its company; the company is
 * read from the delivery row and the signature checked against it, so a link
 * minted for one tenant can never open another's document. It lives as long
 * as the receipt does (PROOF_VERIFICATION_TTL_DAYS, ADR 0009), counted from
 * the delivery's creation because the link exists before any document does.
 *
 * What it opens is the panel's document — produced on the first opening,
 * never rebuilt here — and the answer is that file's short-lived URL.
 */
@injectable()
class OpenProofLinkUseCase {
  constructor(
    @inject("IntegrationRepository")
    private integration: Pick<IIntegrationRepository, "findProofLinkTarget">,
    @inject(GetProofDocumentUseCase)
    private proofs: Pick<GetProofDocumentUseCase, "executeForProofLink">,
  ) {}

  /** The URL of the receipt's PDF, or the 404. */
  async execute(token: string, now: Date = new Date()): Promise<string> {
    const read = readProofLinkToken(token);

    // Shaped wrong: refused before any lookup.
    if (!read) throw proofNotFound();

    const target = await this.integration.findProofLinkTarget(read.deliveryId);

    if (
      !target ||
      !proofLinkSigns(read.signature, read.deliveryId, target.businessId)
    ) {
      throw proofNotFound();
    }

    const expiresAt =
      target.created_at.getTime() + env.PROOF_VERIFICATION_TTL_DAYS * DAY_MS;

    if (now.getTime() > expiresAt) throw proofNotFound();

    // Reopened or cancelled since the link was sent: there is no receipt to
    // show for a delivery that has not ended.
    if (!PROOF_LINK_STATUSES.includes(target.status)) throw proofNotFound();

    try {
      const document = await this.proofs.executeForProofLink({
        businessId: target.businessId,
        deliveryId: read.deliveryId,
      });

      return document.url;
    } catch (error) {
      // Deleted or reopened between the read above and the document: the
      // same 404 as every other link that does not open. Storage and
      // signing failures (503) pass through, to be retried.
      if (
        error instanceof AppError &&
        (error.code === "DELIVERY_NOT_FOUND" ||
          error.code === "DELIVERY_NOT_SETTLED")
      ) {
        throw proofNotFound();
      }

      throw error;
    }
  }
}

export { OpenProofLinkUseCase };
