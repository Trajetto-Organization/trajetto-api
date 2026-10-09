import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteUserUseCase } from "./delete-user-usecase";

import { updateDeleteUserSchema } from "@/schemas/update-delete-user-schema";

class DeleteUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { userId } = updateDeleteUserSchema.parse(request.params);

    const deleteUserUseCase = container.resolve(DeleteUserUseCase);

    await deleteUserUseCase.execute({ userId, id });
    return reply
      .status(200)
      .send({ message: "Usuário deletado com sucesso!" });
  }
}

export { DeleteUserController };
