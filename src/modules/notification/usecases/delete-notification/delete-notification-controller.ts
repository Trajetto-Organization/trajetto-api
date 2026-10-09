import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteNotificationUseCase } from "./delete-notification-usecase";
import { updateDeleteUserNotificationSchema } from "@/schemas/delete-user-notification-schema";

class DeleteNotificationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { notificationId } = updateDeleteUserNotificationSchema.parse(
      request.params,
    );

    const deleteNotificationUseCase = container.resolve(
      DeleteNotificationUseCase,
    );

    await deleteNotificationUseCase.execute({
      notificationId,
      userId: id,
    });

    return reply.status(200).send({
      message: "Notificação excluída com sucesso!",
    });
  }
}

export { DeleteNotificationController };
