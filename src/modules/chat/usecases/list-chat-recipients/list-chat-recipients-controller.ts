import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import { ListChatRecipientsUseCase } from "./list-chat-recipients-usecase";

import { listChatRecipientsSchema } from "@/schemas/list-chat-recipients-schema";

class ListChatRecipientsController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;

    // Already validated and transformed by the route (limit is a number).
    const { businessId, search, app, cursor, limit } = request.query as z.infer<
      typeof listChatRecipientsSchema
    >;

    const listChatRecipientsUseCase = container.resolve(
      ListChatRecipientsUseCase,
    );

    const result = await listChatRecipientsUseCase.execute({
      userId: id,
      businessId,
      search,
      app,
      cursor,
      limit,
    });

    return reply.status(200).send(result);
  }
}

export { ListChatRecipientsController };
