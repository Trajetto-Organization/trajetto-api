import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateTwoFactorAuthenticationUseCase } from "./update-two-factor-authentication-usecase";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

class UpdateTwoFactorAuthenticationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const updateTwoFactorAuthenticationUseCase = container.resolve(
      UpdateTwoFactorAuthenticationUseCase,
    );

    try {
      await updateTwoFactorAuthenticationUseCase.execute({
        userId: id,
      });

      return reply.status(200).send({
        message: "Autenticação de dois fatores atualizada com sucesso!",
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateTwoFactorAuthenticationController };
