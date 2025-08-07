import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { InvalidTokenError } from "../errors/invalid-token-error";
import { ExpiredTokenError } from "../errors/expired-token-error";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { EmailVerificationUseCase } from "./e-mail-verification-usecase";

import { emailVerificationVerificationSchema } from "@/schemas/email-verification-schema";
import { MissingTokenError } from "../errors/missing-token-error";

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
      if (error instanceof MissingTokenError) {
        return reply.status(400).send({ message: error.message });
      }

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

export { EmailVerificationController };
