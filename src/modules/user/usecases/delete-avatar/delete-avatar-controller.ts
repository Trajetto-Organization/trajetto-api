import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { DeleteAvatarUseCase } from "./delete-avatar-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class DeleteAvatarController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const deleteAvatarUseCase = container.resolve(DeleteAvatarUseCase);

    try {
      await deleteAvatarUseCase.execute(id);

      return reply
        .status(200)
        .send({ message: "Avatar deletado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteAvatarController };
