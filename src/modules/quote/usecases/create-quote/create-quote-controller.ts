import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateQuoteUseCase } from "./create-quote-usecase";
import { createQuoteSchema } from "@/schemas/create-quote-schema";

class CreateQuoteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const createQuote = createQuoteSchema.parse(request.body);
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
