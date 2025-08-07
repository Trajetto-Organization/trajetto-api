import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SendForgotPasswordMailUseCase } from "./send-forgot-password-mail-usecase";
import { EmailNotFoundError } from "../errors/email-not-found-error";

import { sendForgotPasswordSchema } from "@/schemas/send-forgot-password-schema";

class SendForgotPasswordMailController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { email } = sendForgotPasswordSchema.parse(request.body);

    const sendForgotPasswordMailUseCase = container.resolve(
      SendForgotPasswordMailUseCase,
    );

    try {
      await sendForgotPasswordMailUseCase.execute(email);
      return reply.status(200).send({
        message:
          "Se este e-mail corresponder a um endereço cadastrado, você receberá um e-mail com as instruções de redefinição da senha.",
      });
    } catch (error) {
      if (error instanceof EmailNotFoundError) {
        return reply.status(200).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { SendForgotPasswordMailController };
