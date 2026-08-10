import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { LogoutUseCase } from "./logout-usecase";

class LogoutController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const logout = container.resolve(LogoutUseCase);

    await logout.execute(request.user.sessionId);

    return reply.status(200).send({
      code: "AUTH_LOGGED_OUT",
      message: "Sessao encerrada com sucesso.",
    });
  }
}

export { LogoutController };
