import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteNotificationUseCase } from "./delete-notification-usecase";
import { updateDeleteUserNotificationSchema } from "@/schemas/delete-user-notification-schema";

import { NotificationNotFoundError } from "../errors/notification-not-found-error";
import { NotificationNotAuthorizedError } from "../errors/notification-not-authorized-error";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

class DeleteNotificationController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    try {
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
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({ message: error.message });
      }

      if (error instanceof NotificationNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      if (error instanceof NotificationNotAuthorizedError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteNotificationController };
