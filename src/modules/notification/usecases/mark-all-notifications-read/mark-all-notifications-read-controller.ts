import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { MarkAllNotificationsReadUseCase } from "./mark-all-notifications-read-usecase";

class MarkAllNotificationsReadController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;

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
  }
}

export { MarkAllNotificationsReadController };
