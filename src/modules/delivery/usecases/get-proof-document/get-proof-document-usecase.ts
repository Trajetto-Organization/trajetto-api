import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IProofDocumentRepository } from "../../repositories/IProof-document-repository";

import { UploadService } from "@/shared/services/upload-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { buildProofDocumentModel } from "@/shared/delivery/proof-document";
import { renderProofPdf } from "@/shared/services/proof-pdf-service";

import {
  newVerificationToken,
  proofFilename,
  proofStorageKey,
} from "@/shared/delivery/proof-storage";

import { AppError } from "@/shared/errors/AppError";
import { env } from "@/env";

import type { ProofDocumentRecord } from "../../dtos/proof-document-dto";

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
}

/**
 * The receipt, produced the first time somebody asks for it.
 *
 * Lazy on purpose. Most deliveries never have their PDF opened, and rendering
 * five million documents a month so that two percent are read is work nobody
 * asked for — work that would also sit in the path of the driver's proof
 * request, on a truck, on 3G, where the difference between fast and slow is a
 * proof that lands and one that times out.
 *
 * Only a delivery that actually ended gets one. A receipt for a delivery still
 * in transit would be a document asserting something that has not happened.
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
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
    regenerate,
  }: GetProofDocumentRequest): Promise<GetProofDocumentResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw new ResourceNotFoundError();

    assertTenantAccess(findUser, businessId);

    const source = await this.documents.loadSource(deliveryId, businessId);

    // Same 404 for "does not exist" and "is not yours".
    if (!source) {
      throw new AppError("Entrega não encontrada.", 404, "DELIVERY_NOT_FOUND");
    }

    /**
     * Um motorista alcança só o próprio trabalho, a mesma regra da listagem
     * dele.
     *
     * Isto comparava com `null`, o que testava se a entrega TEM um motorista —
     * verdadeiro para toda entrega atribuída a qualquer pessoa da empresa. Um
     * motorista lia o comprovante do colega: nome e documento do destinatário,
     * endereço completo, GPS da entrega, foto do canhoto e assinatura. E com
     * `?regenerate=true` também era escrita.
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

    const existing = await this.documents.findByDelivery(deliveryId, businessId);

    if (existing && !regenerate) {
      return this.present(existing, source);
    }

    const model = buildProofDocumentModel(source, {
      verificationBaseUrl: env.HTTP_REQUEST,

      // A regeneration keeps the token: a customer holding a printed QR from
      // last week must still reach the page.
      verificationToken: existing?.verification_token ?? newVerificationToken(),
    });

    const [photo, signature] = await Promise.all([
      model.photoKey ? this.uploads.readObject(model.photoKey) : null,
      model.signatureKey ? this.uploads.readObject(model.signatureKey) : null,
    ]);

    const rendered = await renderProofPdf(model, { photo, signature });

    const storageKey = proofStorageKey(deliveryId);

    await this.uploads.putObject(storageKey, rendered.bytes, "application/pdf");

    const saved = await this.documents.save({
      deliveryId,
      businessId,
      storage_key: storageKey,
      sha256: rendered.sha256,
      verification_token:
        existing?.verification_token ?? model.verificationUrl.split("/").pop()!,
      size_bytes: rendered.bytes.length,
    });

    return this.present(saved, source);
  }

  private async present(
    document: ProofDocumentRecord,
    source: Awaited<ReturnType<IProofDocumentRepository["loadSource"]>>,
  ): Promise<GetProofDocumentResult> {
    const base = (env.HTTP_REQUEST).replace(/\/+$/, "");

    return {
      document,
      url: await this.uploads.getFileUrl(document.storage_key),
      filename: proofFilename(source!.delivery),
      verificationUrl: `${base}/verificar/${document.verification_token}`,
    };
  }
}

export { GetProofDocumentUseCase };
export type { GetProofDocumentResult };
