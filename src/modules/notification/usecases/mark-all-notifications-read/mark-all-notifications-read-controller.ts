import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { MarkAllNotificationsReadUseCase } from "./mark-all-notifications-read-usecase";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class MarkAllNotificationsReadController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;

    try {
      const markAllNotificationsReadUseCase = container.resolve(
        MarkAllNotificationsReadUseCase,
      );

      const count = await markAllNotificationsReadUseCase.execute(userId);

      return reply.status(200).send({
        message:
          count === 0
            ? "Nenhuma notificação pendente."
            : `${count} ${count === 1 ? "notificação marcada" : "notificações marcadas"} como lida${count === 1 ? "" : "s"}.`,
        count,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { MarkAllNotificationsReadController };
