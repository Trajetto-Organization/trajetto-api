import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteQuoteUseCase } from "./delete-quote-usecase";

import { QuoteAccessDeniedError } from "../errors/quote-access denied-error";
import { QuoteNotFoundError } from "../errors/quote-not-found-error";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class DeleteQuoteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id: userId } = request.user;
    const { quoteId } = request.params as { quoteId: string };

    const deleteQuoteUseCase = container.resolve(DeleteQuoteUseCase);

    try {
      await deleteQuoteUseCase.execute(quoteId, userId);
      return reply.status(200).send({
        message: "Orçamento deletado com sucesso!",
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof QuoteNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      if (error instanceof QuoteAccessDeniedError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteQuoteController };
