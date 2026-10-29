import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { GetProofDocumentUseCase } from "./get-proof-document-usecase";

import {
  proofDocumentParamsSchema,
  proofDocumentQuerySchema,
} from "@/schemas/proof-document-schema";

import {
  decidePermission,
  type PermissionPrincipal,
} from "@/modules/middlewares/verify-permission";
import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";

/**
 * `regenerate=true` is a write: a new object in storage, the row pointed at
 * it and the version bumped — every copy a customer already holds then reads
 * as superseded on /verificar. The route is guarded for reading (the first
 * render is part of reading), so the write's own guards run here, the same
 * two a write route declares: write permission (decision 4.2, read-only
 * never writes) and an active company (decision 4.1, TENANT_INACTIVE).
 */
async function authorizeRegeneration(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const refusal = decidePermission(
    request.user as PermissionPrincipal,
    "delivery_manage",
    "write",
  );

  if (refusal) throw refusal;

  await verifyBusinessActive(request, reply);
}

class GetProofDocumentController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { deliveryId, businessId } = proofDocumentParamsSchema.parse(
      request.params,
    );

    const { regenerate } = request.query as z.infer<
      typeof proofDocumentQuerySchema
    >;

    // Before the delivery is read or anything rendered: a refused
    // regeneration costs nothing and says nothing about the delivery.
    if (regenerate) await authorizeRegeneration(request, reply);

    const useCase = container.resolve(GetProofDocumentUseCase);

    // Refusals are AppErrors with their code (a user row gone is 404
    // USER_NOT_FOUND), answered by the global handler.
    const result = await useCase.execute({
      userId: id,
      businessId,
      deliveryId,
      regenerate,
    });

    // A link and a hash, not the bytes: the file lives in the bucket and the
    // browser fetches it straight from there, the same way every other
    // attachment in the product does.
    return reply.status(200).send({
      message: "Comprovante disponível.",
      data: {
        url: result.url,
        filename: result.filename,
        verificationUrl: result.verificationUrl,
        sha256: result.document.sha256,
        version: result.document.version,
        generated_at: result.document.generated_at,
        size_bytes: result.document.size_bytes,

        // Decision 14.8: which layout the stored file has and whether it is
        // signed — the web offers "Gerar novamente" from these.
        layout_version: result.document.layout_version,
        signature: {
          status: result.document.signature_status,
          profile: result.document.signature_profile,
          signer_name: result.document.signer_name,
          signer_cnpj: result.document.signer_cnpj,
          cert_not_after: result.document.cert_not_after,
          signed_at: result.document.signed_at,
          // Only true lets the web say "ICP-Brasil" next to the signature.
          icp_brasil: result.document.cert_icp_brasil ?? null,
          unsigned_reason: result.document.unsigned_reason,
        },
        signing_available: result.signingAvailable,
      },
    });
  }
}

export { GetProofDocumentController };
