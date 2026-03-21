import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UserInvalidTokenError } from "../errors/user-invalid-token-error";
import { UserExpiredTokenError } from "../errors/user-expired-token-error";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { EmailVerificationUseCase } from "./e-mail-verification-usecase";

import { emailVerificationVerificationSchema } from "@/schemas/email-verification-schema";
import { UserMissingTokenError } from "../errors/user-missing-token-error";

class EmailVerificationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { token } = emailVerificationVerificationSchema.parse(request.query);

    const emailVerificationUseCase = container.resolve(
      EmailVerificationUseCase,
    );

    try {
      await emailVerificationUseCase.execute(token as string);
      return reply
        .status(200)
        .send({ message: "E-mail confirmado com sucesso!" });
    } catch (error) {
      if (error instanceof UserMissingTokenError) {
        return reply.status(400).send({ message: error.message });
      }

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

export { EmailVerificationController };
