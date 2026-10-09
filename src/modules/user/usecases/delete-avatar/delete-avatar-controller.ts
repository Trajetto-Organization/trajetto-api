import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { DeleteAvatarUseCase } from "./delete-avatar-usecase";

class DeleteAvatarController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const deleteAvatarUseCase = container.resolve(DeleteAvatarUseCase);

    await deleteAvatarUseCase.execute(id);
    return reply
      .status(200)
      .send({ message: "Avatar deletado com sucesso!" });
  }
}

export { DeleteAvatarController };
