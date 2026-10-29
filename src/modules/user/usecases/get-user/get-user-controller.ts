import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetUserUseCase } from "./get-user-usecase";

class GetUserController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const getUserUseCase = container.resolve(GetUserUseCase);

    const user = await getUserUseCase.execute(id);

    return reply.status(200).send({
      message: "Usuário retornado com sucesso!",
      user: {
        ...user,
        password: undefined,
      },
    });
  }
}

export { GetUserController };
