import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ResendTwoFactorCodeUseCase } from "./resend-two-factor-code-usecase";

import { resendTwoFactorCodeSchema } from "@/schemas/resend-two-factor-code-schema";

class ResendTwoFactorCodeController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { email, challenge } = resendTwoFactorCodeSchema.parse(request.body);

    const resendTwoFactorCodeUseCase = container.resolve(
      ResendTwoFactorCodeUseCase,
    );

    const { twoFactorVerificationMessage } =
      await resendTwoFactorCodeUseCase.execute(email, challenge);

    return reply.status(200).send({
      message: twoFactorVerificationMessage,
    });
  }
}

export { ResendTwoFactorCodeController };
