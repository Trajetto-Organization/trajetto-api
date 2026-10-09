import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateQuoteStatusUseCase } from "./update-quote-status-usecase";
import { updateQuoteStatusSchema } from "@/schemas/update-quote-status-schema";

class UpdateQuoteStatusController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { quoteId } = request.params as { quoteId: string };
    const { status, notes } = updateQuoteStatusSchema.parse(request.body);

    const updateQuoteStatusUseCase = container.resolve(
      UpdateQuoteStatusUseCase,
    );

    await updateQuoteStatusUseCase.execute({
      quoteId,
      status,
      notes,
      userId: id,
    });

    return reply.status(200).send({
      message: "Status do orçamento atualizado com sucesso!",
    });
  }
}

export { UpdateQuoteStatusController };
