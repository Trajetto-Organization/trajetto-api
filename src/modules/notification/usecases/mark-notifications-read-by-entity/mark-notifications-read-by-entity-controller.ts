import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { MarkNotificationsReadByEntityUseCase } from "./mark-notifications-read-by-entity-usecase";
import { readNotificationsByEntitySchema } from "@/schemas/read-notifications-by-entity-schema";

class MarkNotificationsReadByEntityController {
  async handle(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;
    const { type, entityId } = readNotificationsByEntitySchema.parse(
      request.body,
    );

    const markNotificationsReadByEntityUseCase = container.resolve(
      MarkNotificationsReadByEntityUseCase,
    );

    const count = await markNotificationsReadByEntityUseCase.execute({
      userId,
      type,
      entityId,
    });

    return reply.status(200).send({
      message:
        count === 0
          ? "Nenhuma notificação pendente sobre este item."
          : `${count} ${count === 1 ? "notificação marcada" : "notificações marcadas"} como lida${count === 1 ? "" : "s"}.`,
      count,
    });
  }
}

export { MarkNotificationsReadByEntityController };
