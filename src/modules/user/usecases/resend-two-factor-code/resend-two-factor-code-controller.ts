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

    // How many callers still send no challenge: the signal for switching
    // TWO_FACTOR_CHALLENGE_REQUIRED on (WEB-07).
    if (!challenge) {
      request.log.info(
        { event: "auth.two_factor_without_challenge", step: "resend" },
        "Two-factor request without challenge",
      );
    }

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
