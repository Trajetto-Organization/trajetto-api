import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import type { MultipartFile } from "@fastify/multipart";

import { UploadAvatarUseCase } from "./upload-avatar-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { presignedPhotoSchema } from "@/schemas/presigned-photos-schema";

class UploadAvatarController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    let file: MultipartFile | undefined;
    let presignedPhoto: { key: string } | undefined;

    if (request.isMultipart()) {
      file = await request.file();

      if (!file) {
        return reply.status(400).send({
          message: "Arquivo de avatar é obrigatório.",
        });
      }
    } else {
      // JSON body: the image is already in storage and only its key arrives
      // here. `request.file()` is not called — there is no stream to read.
      const body = (request.body ?? {}) as Record<string, unknown>;
      const parsed = presignedPhotoSchema.safeParse(body.photo);

      if (!parsed.success) {
        return reply.status(400).send({
          message: "Arquivo de avatar é obrigatório.",
        });
      }

      presignedPhoto = { key: parsed.data.key };
    }

    const uploadAvatarUseCase = container.resolve(UploadAvatarUseCase);

    try {
      await uploadAvatarUseCase.execute(id, file, presignedPhoto);
      return reply
        .status(200)
        .send({ message: "Avatar atualizado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UploadAvatarController };
