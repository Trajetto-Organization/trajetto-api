import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CountUnreadNotificationsUseCase } from "./count-unread-notifications-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class CountUnreadNotificationsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    try {
      const { id } = request.user;

      const countUnreadNotificationsUseCase = container.resolve(
        CountUnreadNotificationsUseCase,
      );

      const result = await countUnreadNotificationsUseCase.execute(id);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CountUnreadNotificationsController };
