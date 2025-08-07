import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetUserUseCase } from "./get-user-usecase";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

class GetUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const getUserUseCase = container.resolve(GetUserUseCase);

    try {
      const user = await getUserUseCase.execute(id);

      return reply.status(200).send({
        message: "Usuário retornado com sucesso!",
        user: {
          ...user,
          password: undefined,
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

export { GetUserController };
