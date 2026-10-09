import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { UploadAvatarUseCase } from "./upload-avatar-usecase";

import { presignedPhotoSchema } from "@/schemas/presigned-photos-schema";
import { AppError } from "@/shared/errors/AppError";
import { TENANT_MOVE_REFUSED } from "@/shared/validation/tenant-locked-field";

class UploadAvatarController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The image is already in storage and only its key arrives here.
    const body = (request.body ?? {}) as Record<string, unknown>;

    // Parsed by hand, so the shared lock is applied by hand: no edit body
    // names a company (decision 16.100), with the same 400 as the others.
    if (body.businessId !== undefined) {
      return reply.header("x-error-code", "VALIDATION_ERROR").status(400).send({
        code: "VALIDATION_ERROR",
        message: TENANT_MOVE_REFUSED,
        issues: [TENANT_MOVE_REFUSED],
      });
    }
    const parsed = presignedPhotoSchema.safeParse(body.photo);

    if (!parsed.success) {
      // A coded refusal like every other (decision 11.3), not a bare message.
      throw new AppError(
        "Arquivo de avatar é obrigatório.",
        400,
        "AVATAR_PHOTO_REQUIRED",
      );
    }

    const uploadAvatarUseCase = container.resolve(UploadAvatarUseCase);

    await uploadAvatarUseCase.execute(id, { key: parsed.data.key });
    return reply
      .status(200)
      .send({ message: "Avatar atualizado com sucesso!" });
  }
}

export { UploadAvatarController };
