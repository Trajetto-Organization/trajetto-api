import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ListQuotesUseCase } from "./list-quotes-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { listQuotesQuerySchema } from "@/schemas/list-quotes-query-schema";
import { sendAsNDJSON } from "@/config/stream-utils";

import { QuoteAccessDeniedError } from "../errors/quote-access denied-error";

class ListQuotesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    const { page, pageSize, search, status } = listQuotesQuerySchema.parse(
      request.query,
    );

    const listQuotesUseCase = container.resolve(ListQuotesUseCase);

    let decodedSearch: string | undefined = undefined;
    if (search) {
      try {
        decodedSearch = decodeURIComponent(search);
      } catch (error) {
        decodedSearch = search;
      }
    }

    try {
      const quotesList = listQuotesUseCase.execute({
        userId: id,
        page,
        pageSize,
        search: decodedSearch,
        status,
      });

      await sendAsNDJSON({
        reply,
        dataPromise: quotesList,
        page,
        pageSize,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof QuoteAccessDeniedError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ListQuotesController };
