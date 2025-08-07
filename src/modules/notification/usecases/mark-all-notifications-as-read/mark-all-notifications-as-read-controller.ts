import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { MarkAllNotificationsAsReadUseCase } from "./mark-all-notifications-as-read-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class MarkAllNotificationsAsReadController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    try {
      const { id } = request.user;

      const markAllNotificationsAsReadUseCase = container.resolve(
        MarkAllNotificationsAsReadUseCase,
      );

      await markAllNotificationsAsReadUseCase.execute(id);

      return reply.status(200).send({
        message: "Todas as notificações foram marcadas como lidas!",
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { MarkAllNotificationsAsReadController };
