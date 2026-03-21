import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UserInvalidTokenError } from "../errors/user-invalid-token-error";
import { UserExpiredTokenError } from "../errors/user-expired-token-error";

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
      if (error instanceof UserInvalidTokenError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserExpiredTokenError) {
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
