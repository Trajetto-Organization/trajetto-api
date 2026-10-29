import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

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

    await forgotPasswordVerificationUseCase.execute(token as string);
    return reply.status(200).send({
      message: `Token "esqueci minha senha" confirmada com sucesso!`,
    });
  }
}

export { ForgotPasswordVerificationController };
