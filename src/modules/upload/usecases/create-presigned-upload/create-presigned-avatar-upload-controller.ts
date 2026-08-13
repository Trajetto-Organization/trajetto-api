import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreatePresignedUploadUseCase } from "./create-presigned-upload-usecase";
import { presignedUploadFilesSchema } from "@/schemas/create-presigned-upload-schema";

import { AppError } from "@/shared/errors/AppError";
import { buildPublicBaseUrl } from "@/shared/utils/public-base-url";

/**
 * Authorises an avatar upload.
 *
 * Separate from the business endpoint because an avatar has no tenant: it
 * belongs to a person, and a MASTER user may have no business at all. Routing
 * it through `/presign/:businessId` would force the client to invent a tenant
 * id for a file that is not scoped by one.
 */
class CreatePresignedAvatarUploadController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id: userId } = request.user;
    const { files } = presignedUploadFilesSchema.parse(request.body);

    const createPresignedUploadUseCase = container.resolve(
      CreatePresignedUploadUseCase,
    );

    try {
      const uploads = await createPresignedUploadUseCase.execute({
        uploadType: "avatars",
        files,

        // The key is namespaced by the caller's own id, so one user cannot
        // write into another user's avatar prefix.
        scopeId: userId,
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

export { CreatePresignedAvatarUploadController };
