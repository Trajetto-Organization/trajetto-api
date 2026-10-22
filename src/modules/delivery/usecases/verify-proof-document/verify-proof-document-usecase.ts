import { inject, injectable } from "tsyringe";

import { IProofDocumentRepository } from "../../repositories/IProof-document-repository";
import { UploadService } from "@/shared/services/upload-service";

import { createHash } from "node:crypto";

import { AppError } from "@/shared/errors/AppError";
import { resolveTimeZone } from "@/shared/time/business-day";
import { env } from "@/env";
import type { PublicProofSummary } from "../../dtos/proof-document-dto";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a document generated at `generatedAt` is past its public life. */
function isPastRetention(generatedAt: Date | string): boolean {
  const generated = new Date(generatedAt).getTime();

  // A date that cannot be read is not a reason to hide a receipt.
  if (!Number.isFinite(generated)) return false;

  return Date.now() - generated > env.PROOF_VERIFICATION_TTL_DAYS * DAY_MS;
}

interface VerifyProofDocumentRequest {
  token: string;
}

interface VerifyProofDocumentResult {
  /**
   * Whether the bytes sitting in the bucket right now still hash to what was
   * recorded when the document was made.
   *
   * This is the whole feature. Anything else on the page is context; this line
   * is the reason somebody scanned the code.
   */
  intact: boolean;

  /** Null when the object is gone — which is NOT the same as "tampered". */
  storedSha256: string | null;

  summary: PublicProofSummary;

  /** Short-lived link to the file itself. */
  url: string | null;
}

/**
 * The page a QR code lands on.
 *
 * Open to anyone holding the token, which is why what it answers is narrow: a
 * leaked link must show that one receipt is genuine, not become a window on
 * the carrier's operation. No shipper, no route, no other stop, no driver
 * document.
 *
 * It re-reads the file and re-hashes it rather than trusting the row. A row
 * that says "sha256: abc" proves nothing on its own — the point is to compare
 * it against the bytes actually being served, which is the only comparison
 * that would catch a file replaced in the bucket.
 */
@injectable()
class VerifyProofDocumentUseCase {
  constructor(
    @inject("ProofDocumentRepository")
    private documents: IProofDocumentRepository,
    @inject("UploadService")
    private uploads: UploadService,
  ) {}

  async execute({
    token,
  }: VerifyProofDocumentRequest): Promise<VerifyProofDocumentResult> {
    const found = await this.documents.findByVerificationToken(token);

    // 404 and nothing else. A distinct "this token expired" or "this token is
    // malformed" would let somebody probe the space.
    //
    // Expired counts as missing (GAP1-8). The token is printed on the paper
    // and needs no login, so whoever photographs a receipt holds its PDF —
    // recipient document and GPS included, because those are the evidence.
    // Past the retention period nobody needs the check any more, and the
    // link stops being a standing window on somebody's personal data.
    if (!found || isPastRetention(found.generated_at)) {
      throw new AppError("Comprovante não encontrado.", 404, "PROOF_NOT_FOUND");
    }

    const delivery = found.delivery as {
      recipient_name: string;
      city: string;
      uf: string;
      invoice_number: string | null;
      delivered_at: Date | string | null;
      received_by: string | null;
      business: {
        corporate_reason: string;
        fantasy_name: string | null;
        timezone?: string | null;
      };
    } | null;

    const bytes = await this.uploads.readObject(found.storage_key);

    const storedSha256 = bytes
      ? createHash("sha256").update(bytes).digest("hex")
      : null;

    return {
      intact: storedSha256 !== null && storedSha256 === found.sha256,
      storedSha256,

      summary: {
        recipientName: delivery?.recipient_name ?? "",
        city: delivery?.city ?? "",
        uf: delivery?.uf ?? "",

        invoiceNumber: delivery?.invoice_number ?? null,

        carrierName:
          delivery?.business.fantasy_name?.trim() ||
          delivery?.business.corporate_reason ||
          "",

        deliveredAt: delivery?.delivered_at ?? null,
        receivedBy: delivery?.received_by ?? null,

        sha256: found.sha256,
        generatedAt: found.generated_at,
        version: found.version,

        // Resolved like the PDF's (proof-document formatMoment): the page and
        // the paper show the same clock for the same moment.
        timeZone: resolveTimeZone(delivery?.business.timezone),

        // What WE recorded about the signature (decision 14.8). Legal
        // validity is the ITI validator's to say, on the file itself.
        signature: {
          status: found.signature_status ?? "UNSIGNED",
          profile: found.signature_profile ?? null,
          signerName: found.signer_name ?? null,
          certNotAfter: found.cert_not_after ?? null,
          signedAt: found.signed_at ?? null,
        },
      },

      url: bytes ? await this.uploads.getFileUrl(found.storage_key) : null,
    };
  }
}

export { VerifyProofDocumentUseCase };
export type { VerifyProofDocumentResult };
