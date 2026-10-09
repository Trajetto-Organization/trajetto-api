import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteMasterUserUseCase } from "./delete-master-user-usecase";

import { updateMasterUserParamsSchema } from "@/schemas/update-master-user-schema";

class DeleteMasterUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { masterUserId } = updateMasterUserParamsSchema.parse(request.params);

    const deleteMasterUserUseCase = container.resolve(DeleteMasterUserUseCase);

    await deleteMasterUserUseCase.execute({
      masterUserId,
      performedById: id,
    });

    return reply
      .status(200)
      .send({ message: "Usuário Master removido com sucesso!" });
  }
}

export { DeleteMasterUserController };
