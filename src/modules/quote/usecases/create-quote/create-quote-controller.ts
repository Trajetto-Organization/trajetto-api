import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateQuoteUseCase } from "./create-quote-usecase";
import { createQuoteSchema } from "@/schemas/create-quote-schema";
import { verifyTurnstileToken } from "@/shared/security/turnstile";

class CreateQuoteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { turnstileToken, ...createQuote } = createQuoteSchema.parse(
      request.body,
    );

    // Before anything is written or mailed: this route is public and sends
    // an e-mail to the address in the body, which is what a bot wants.
    await verifyTurnstileToken(turnstileToken);

    const createQuoteUseCase = container.resolve(CreateQuoteUseCase);

    try {
      await createQuoteUseCase.execute(createQuote);
      return reply.status(200).send({
        message:
          "Orçamento solicitado com sucesso! Em breve entraremos em contato.",
      });
    } catch (error) {
      throw error;
    }
  }
}

export { CreateQuoteController };
