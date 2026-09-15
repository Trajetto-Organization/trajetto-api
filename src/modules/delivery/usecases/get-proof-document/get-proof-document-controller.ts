import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { z } from "zod";

import { GetProofDocumentUseCase } from "./get-proof-document-usecase";

import {
  proofDocumentParamsSchema,
  proofDocumentQuerySchema,
} from "@/schemas/proof-document-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class GetProofDocumentController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { deliveryId, businessId } = proofDocumentParamsSchema.parse(
      request.params,
    );

    const { regenerate } = request.query as z.infer<
      typeof proofDocumentQuerySchema
    >;

    const useCase = container.resolve(GetProofDocumentUseCase);

    try {
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
        },
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { GetProofDocumentController };
