import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ResendTwoFactorCodeUseCase } from "./resend-two-factor-code-usecase";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { resendTwoFactorCodeSchema } from "@/schemas/resend-two-factor-code-schema";
import { UserResendTwoFactorError } from "../errors/user-resend-two-factor-error";

class ResendTwoFactorCodeController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { email } = resendTwoFactorCodeSchema.parse(request.body);
    const resendTwoFactorCodeUseCase = container.resolve(
      ResendTwoFactorCodeUseCase,
    );

    try {
      const { twoFactorVerificationMessage } =
        await resendTwoFactorCodeUseCase.execute(email);

      return reply.status(200).send({
        message: twoFactorVerificationMessage,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserResendTwoFactorError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ResendTwoFactorCodeController };
