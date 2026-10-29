import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { EmailVerificationUseCase } from "./e-mail-verification-usecase";

import { emailVerificationVerificationSchema } from "@/schemas/email-verification-schema";

class EmailVerificationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { token } = emailVerificationVerificationSchema.parse(request.query);

    const emailVerificationUseCase = container.resolve(
      EmailVerificationUseCase,
    );

    await emailVerificationUseCase.execute(token as string);
    return reply
      .status(200)
      .send({ message: "E-mail confirmado com sucesso!" });
  }
}

export { EmailVerificationController };
