import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { SearchChatMessagesUseCase } from "./search-chat-messages-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { searchChatMessagesSchema } from "@/schemas/search-chat-messages-schema";

class SearchChatMessagesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // The route already validated AND transformed the querystring (limit is
    // a number) — re-parsing the transformed value would reject it.
    const { search, limit, businessId } = request.query as z.infer<
      typeof searchChatMessagesSchema
    >;

    const searchChatMessagesUseCase = container.resolve(
      SearchChatMessagesUseCase,
    );

    try {
      const { data } = await searchChatMessagesUseCase.execute({
        userId: id,
        search,
        limit,
        businessId,
      });

      return reply.status(200).send({ data });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { SearchChatMessagesController };
