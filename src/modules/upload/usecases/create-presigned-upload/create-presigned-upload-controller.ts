import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreatePresignedUploadUseCase } from "./create-presigned-upload-usecase";

import { createPresignedUploadSchema } from "@/schemas/create-presigned-upload-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { AppError } from "@/shared/errors/AppError";
import { buildPublicBaseUrl } from "@/shared/utils/public-base-url";

class CreatePresignedUploadController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id: userId } = request.user;
    // The tenant comes from the route, not the body, so it passes through the
    // same `enforceRequestedTenant` guard as every other write. The key is
    // built from it, which is what stops a client writing into another
    // business's prefix.
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { uploadType, files } = createPresignedUploadSchema.parse(
      request.body,
    );

    const createPresignedUploadUseCase = container.resolve(
      CreatePresignedUploadUseCase,
    );

    try {
      const uploads = await createPresignedUploadUseCase.execute({
        uploadType,
        files,

        // An avatar belongs to a person, not to a company — and a MASTER user
        // may have no business at all, which would leave the key prefix empty.
        scopeId: uploadType === "avatars" ? userId : businessId,
        publicBaseUrl: buildPublicBaseUrl(request),
      });

      return reply.status(201).send({ uploads });
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({ message: error.message });
      }

      return reply
        .status(500)
        .send({ message: "Não foi possível autorizar o upload." });
    }
  }
}

export { CreatePresignedUploadController };
