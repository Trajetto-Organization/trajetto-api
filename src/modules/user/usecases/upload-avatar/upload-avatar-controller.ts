import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { UploadAvatarUseCase } from "./upload-avatar-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class UploadAvatarController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const file = await request.file();

    if (!file) {
      return reply.status(400).send({
        message: "Arquivo de avatar é obrigatório.",
      });
    }

    const uploadAvatarUseCase = container.resolve(UploadAvatarUseCase);

    try {
      await uploadAvatarUseCase.execute(id, file);
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
