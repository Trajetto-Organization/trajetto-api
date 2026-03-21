import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ResetUserPasswordUseCase } from "./reset-user-password-usecase";
import { UserInvalidTokenError } from "../errors/user-invalid-token-error";

import { UserExpiredTokenError } from "../errors/user-expired-token-error";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { forgotPasswordSchema } from "@/schemas/forgot-password-schema";
import { forgotPasswordVerificationSchema } from "@/schemas/forgot-password-verification-schema";

class ResetUserPasswordController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { token } = forgotPasswordVerificationSchema.parse(request.query);
    const { password } = forgotPasswordSchema.parse(request.body);

    const resetUserPasswordUseCase = container.resolve(
      ResetUserPasswordUseCase,
    );

    try {
      await resetUserPasswordUseCase.execute({
        token: token as string,
        password,
      });

      return reply
        .status(200)
        .send({ message: "Senha redefinida com sucesso!" });
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

export { ResetUserPasswordController };
