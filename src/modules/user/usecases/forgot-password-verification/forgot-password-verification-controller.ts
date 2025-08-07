import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { InvalidTokenError } from "../errors/invalid-token-error";
import { ExpiredTokenError } from "../errors/expired-token-error";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { ForgotPasswordVerificationUseCase } from "./forgot-password-verification-usecase";

import { forgotPasswordVerificationSchema } from "@/schemas/forgot-password-verification-schema";

class ForgotPasswordVerificationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { token } = forgotPasswordVerificationSchema.parse(request.query);

    const forgotPasswordVerificationUseCase = container.resolve(
      ForgotPasswordVerificationUseCase,
    );

    try {
      await forgotPasswordVerificationUseCase.execute(token as string);
      return reply.status(200).send({
        message: `Token "esqueci minha senha" confirmada com sucesso!`,
      });
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ExpiredTokenError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ForgotPasswordVerificationController };
