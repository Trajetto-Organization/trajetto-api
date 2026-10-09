import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SendForgotPasswordMailUseCase } from "./send-forgot-password-mail-usecase";

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

    // One answer whatever the address: the use case returns the same way for
    // an unknown e-mail and sends the link after answering for a known one.
    await sendForgotPasswordMailUseCase.execute(email);

    return reply.status(200).send({
      message:
        "Se este e-mail corresponder a um endereço cadastrado, você receberá um e-mail com as instruções de redefinição da senha.",
    });
  }
}

export { SendForgotPasswordMailController };
