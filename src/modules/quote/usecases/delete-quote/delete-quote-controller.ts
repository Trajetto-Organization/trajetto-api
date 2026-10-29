import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteQuoteUseCase } from "./delete-quote-usecase";

class DeleteQuoteController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id: userId } = request.user;
    const { quoteId } = request.params as { quoteId: string };

    const deleteQuoteUseCase = container.resolve(DeleteQuoteUseCase);

    await deleteQuoteUseCase.execute(quoteId, userId);
    return reply.status(200).send({
      message: "Orçamento deletado com sucesso!",
    });
  }
}

export { DeleteQuoteController };
