import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateTwoFactorAuthenticationUseCase } from "./update-two-factor-authentication-usecase";

class UpdateTwoFactorAuthenticationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const updateTwoFactorAuthenticationUseCase = container.resolve(
      UpdateTwoFactorAuthenticationUseCase,
    );

    await updateTwoFactorAuthenticationUseCase.execute({
      userId: id,
    });

    return reply.status(200).send({
      message: "Autenticação de dois fatores atualizada com sucesso!",
    });
  }
}

export { UpdateTwoFactorAuthenticationController };
