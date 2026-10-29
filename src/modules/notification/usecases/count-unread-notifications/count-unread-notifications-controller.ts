import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CountUnreadNotificationsUseCase } from "./count-unread-notifications-usecase";

class CountUnreadNotificationsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const countUnreadNotificationsUseCase = container.resolve(
      CountUnreadNotificationsUseCase,
    );

    const result = await countUnreadNotificationsUseCase.execute(id);
    return reply.status(200).send(result);
  }
}

export { CountUnreadNotificationsController };
