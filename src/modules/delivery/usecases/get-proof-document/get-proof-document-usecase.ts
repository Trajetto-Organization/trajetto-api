import { inject, injectable } from "tsyringe";

import { createHash } from "node:crypto";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IProofDocumentRepository } from "../../repositories/IProof-document-repository";

import { UploadService } from "@/shared/services/upload-service";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import {
  buildProofDocumentModel,
  type ProofDocumentSource,
} from "@/shared/delivery/proof-document";
import { renderProofPdfOffThread } from "@/shared/services/proof-pdf-renderer";
import {
  ProofSigningService,
  type SigningPlan,
} from "@/shared/services/proof-signing/proof-signing-service";
// Side effect: registers "ProofLocationService" (@registry).
import "@/shared/services/proof-location/proof-location-service";
import type { ProofLocationService } from "@/shared/services/proof-location/proof-location-service";

import {
  newVerificationToken,
  proofFilename,
  proofStorageKey,
} from "@/shared/delivery/proof-storage";

import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";
import { env } from "@/env";

import type {
  ProofDocumentRecord,
  SaveProofDocumentProps,
} from "../../dtos/proof-document-dto";

const log = logger.child({ component: "proof-document" });

/** The layout this code draws (decision 14.8). */
const PROOF_LAYOUT_VERSION = 2;

interface GetProofDocumentRequest {
  userId: string;
  businessId: string;
  deliveryId: string;

  /** Rebuilds even when a document exists — after a correction, say. */
  regenerate?: boolean;
}

interface GetProofDocumentResult {
  document: ProofDocumentRecord;

  /** What the browser downloads. Short-lived, like every other bucket link. */
  url: string;

  filename: string;

  /** The page a QR scan lands on. */
  verificationUrl: string;

  /** Whether a document generated NOW would be signed (certificate READY). */
  signingAvailable: boolean;
}

const signingFailed = () =>
  new AppError(
    "Não foi possível assinar o comprovante agora. Tente novamente em instantes.",
    503,
    "PROOF_SIGNING_FAILED",
  );

/**
 * The receipt, produced the first time somebody asks for it.
 *
 * Lazy on purpose. Most deliveries never have their PDF opened, and rendering
 * five million documents a month so that two percent are read is work nobody
 * asked for — work that would also sit in the path of the driver's proof
 * request, on a truck, on 3G.
 *
 * Only a delivery that actually ended gets one. A receipt for a delivery still
 * in transit would be a document asserting something that has not happened.
 *
 * Signed with the platform's ICP-Brasil certificate when one is READY
 * (decision 14.8). Without one the document says it is unsigned and the row
 * records why. With one, a failure to sign is a 503 and nothing is stored:
 * storing it unsigned would turn a hiccup into a permanently unsigned
 * document.
 */
@injectable()
class GetProofDocumentUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ProofDocumentRepository")
    private documents: IProofDocumentRepository,
    @inject("UploadService")
    private uploads: UploadService,
    @inject("ProofSigningService")
    private signing: ProofSigningService,
    @inject("ProofLocationService")
    private location: ProofLocationService,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
    regenerate,
  }: GetProofDocumentRequest): Promise<GetProofDocumentResult> {
    const findUser = await this.user.findUserById(userId);

    // The session was checked by the middleware; a user row gone since then
    // is a 404 with its code (decision 11.3), not a bare 400.
    if (!findUser) {
      throw new AppError("Usuário não encontrado.", 404, "USER_NOT_FOUND");
    }

    assertTenantAccess(findUser, businessId);

    const source = await this.documents.loadSource(deliveryId, businessId);

    // Same 404 for "does not exist" and "is not yours".
    if (!source) {
      throw new AppError("Entrega não encontrada.", 404, "DELIVERY_NOT_FOUND");
    }

    /**
     * A driver reaches only their own work, the same rule as their listing.
     * Compared by id: "the delivery HAS a driver" is true of every assigned
     * delivery in the company.
     */
    if (
      findUser.driverId &&
      (source.driver as { id?: string } | null)?.id !== findUser.driverId
    ) {
      throw new AppError("Entrega não encontrada.", 404, "DELIVERY_NOT_FOUND");
    }

    if (!["DELIVERED", "FAILED"].includes(source.delivery.status)) {
      throw new AppError(
        "O comprovante existe depois que a entrega termina — esta ainda está em andamento.",
        409,
        "DELIVERY_NOT_SETTLED",
      );
    }

    const existing = await this.documents.findByDelivery(
      deliveryId,
      businessId,
    );

    if (existing && !regenerate) {
      return this.present(existing, source);
    }

    const located = await this.withGpsAddress(source, businessId);

    // A regeneration keeps the token: a customer holding a printed QR from
    // last week must still reach the page.
    if (existing) {
      const stored = await this.renderAndStore(
        located,
        deliveryId,
        businessId,
        existing.verification_token,
      );

      return this.present(await this.documents.save(stored), source);
    }

    // The first document. Insert-only: a second first reader rendering at
    // the same moment drew a different token, and the row must keep one of
    // them with the object that prints it (IDEMP-12).
    const first = await this.renderAndStore(
      located,
      deliveryId,
      businessId,
      newVerificationToken(),
    );

    const { record, created } = await this.documents.createIfAbsent(first);

    if (created) return this.present(record, source);

    // Lost the race: rendered (and signed) again with the winner's token and
    // saved as a regeneration, which keeps the token and points the row at
    // an object that prints it.
    const again = await this.renderAndStore(
      located,
      deliveryId,
      businessId,
      record.verification_token,
    );

    return this.present(await this.documents.save(again), source);
  }

  /**
   * The source with the proof fix's address, from the event's cache or the
   * provider (design §5.1). A provider answer — or its failure — is written
   * on the event so a regeneration prints the same text and asks nobody.
   */
  private async withGpsAddress(
    source: ProofDocumentSource,
    businessId: string,
  ): Promise<ProofDocumentSource> {
    const proof = source.proof;

    if (!proof || source.delivery.status !== "DELIVERED") return source;

    const now = new Date();
    const resolution = await this.location.resolveAddress(proof, now);

    if (!resolution) return source;

    if (resolution.persist && proof.eventId) {
      await this.documents.saveGpsAddress(proof.eventId, businessId, {
        gps_address: resolution.address,
        gps_address_source: resolution.source,
        gps_geocoded_at: now,
      });
    }

    return {
      ...source,
      proof: {
        ...proof,
        gps_address: resolution.address,
        gps_address_source: resolution.source,
        gps_geocoded_at: resolution.persist ? now : proof.gps_geocoded_at,
      },
    };
  }

  /**
   * Renders the receipt for `verificationToken`, signs it when the
   * certificate is READY, and stores it under its content-addressed key
   * (proofStorageKey) before any row points at it. What comes back is the
   * row that describes exactly that object.
   */
  private async renderAndStore(
    source: ProofDocumentSource,
    deliveryId: string,
    businessId: string,
    verificationToken: string,
  ): Promise<SaveProofDocumentProps> {
    const now = new Date();
    const plan: SigningPlan = this.signing.plan(now);

    const model = buildProofDocumentModel(source, {
      // In the API's env HTTP_REQUEST is the WEB app's public URL, where the
      // /verificar page lives (API_HTTP_REQUEST is the API's own).
      verificationBaseUrl: env.HTTP_REQUEST,
      verificationToken,
      signing: plan.intent,
      issuer: {
        brand: env.PROOF_SIGNER_BRAND,
        legalName: env.PROOF_ISSUER_LEGAL_NAME,
        cnpj: env.PROOF_ISSUER_CNPJ ?? null,
      },
    });

    const [photo, signature, map] = await Promise.all([
      model.receipt.photoKey
        ? this.uploads.readObject(model.receipt.photoKey)
        : null,
      model.receipt.signatureKey
        ? this.uploads.readObject(model.receipt.signatureKey)
        : null,
      this.location.map(model.map),
    ]);

    // Off the request's event loop: pdfkit's image work is synchronous CPU.
    // The worker only reserves the signature placeholder; the key stays here.
    const rendered = await renderProofPdfOffThread(
      model,
      { photo, signature, map },
      { signaturePlaceholder: plan.placeholder },
    );

    let bytes = rendered.bytes;

    if (plan.status === "SIGNED") {
      try {
        bytes = await this.signing.sign(rendered.bytes, plan);
      } catch (error) {
        // The error class only; a signing error may quote PDF bytes.
        log.error(
          {
            err: {
              name: (error as Error)?.name,
              message: (error as Error)?.message,
            },
          },
          "proof signing failed",
        );

        throw signingFailed();
      }
    }

    // The hash of the FINAL bytes: the signature is the last write, and
    // /verificar compares exactly these.
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = proofStorageKey(deliveryId, sha256);

    await this.uploads.putObject(storageKey, bytes, "application/pdf");

    return {
      deliveryId,
      businessId,
      storage_key: storageKey,
      sha256,
      verification_token: verificationToken,
      size_bytes: bytes.length,
      layout_version: PROOF_LAYOUT_VERSION,
      ...ProofSigningService.record(plan, now),
    };
  }

  private async present(
    document: ProofDocumentRecord,
    source: ProofDocumentSource,
  ): Promise<GetProofDocumentResult> {
    const base = env.HTTP_REQUEST.replace(/\/+$/, "");

    return {
      document,
      url: await this.uploads.getFileUrl(document.storage_key),
      filename: proofFilename(source.delivery),
      verificationUrl: `${base}/verificar/${document.verification_token}`,
      signingAvailable: this.signing.available(),
    };
  }
}

export { GetProofDocumentUseCase, PROOF_LAYOUT_VERSION };
export type { GetProofDocumentResult };
