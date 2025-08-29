import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateQuoteStatusUseCase } from "./update-quote-status-usecase";
import { updateQuoteStatusSchema } from "@/schemas/update-quote-status-schema";

import { QuoteNotFoundError } from "../errors/quote-not-found-error";
import { QuoteAccessDeniedError } from "../errors/quote-access denied-error";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class UpdateQuoteStatusController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { quoteId } = request.params as { quoteId: string };
    const { status, notes } = updateQuoteStatusSchema.parse(request.body);

    const updateQuoteStatusUseCase = container.resolve(
      UpdateQuoteStatusUseCase,
    );

    try {
      await updateQuoteStatusUseCase.execute({
        quoteId,
        status,
        notes,
        userId: id,
      });

      return reply.status(200).send({
        message: "Status do orçamento atualizado com sucesso!",
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

export { UpdateQuoteStatusController };
