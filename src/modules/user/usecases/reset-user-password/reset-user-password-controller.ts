import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ResetUserPasswordUseCase } from "./reset-user-password-usecase";

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

    await resetUserPasswordUseCase.execute({
      token: token as string,
      password,
    });

    return reply.status(200).send({ message: "Senha redefinida com sucesso!" });
  }
}

export { ResetUserPasswordController };
