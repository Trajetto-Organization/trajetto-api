import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { MarkNotificationAsReadUseCase } from "./mark-notification-as-read-usecase";
import { AppError } from "@/shared/errors/AppError";

import { NotificationNotFoundError } from "../errors/notification-not-found-error";
import { NotificationNotAuthorizedError } from "../errors/notification-not-authorized-error";

import { updateDeleteUserNotificationSchema } from "@/schemas/delete-user-notification-schema";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class MarkNotificationAsReadController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    try {
      const { id } = request.user;
      const { notificationId } = updateDeleteUserNotificationSchema.parse(
        request.params,
      );

      const markNotificationAsReadUseCase = container.resolve(
        MarkNotificationAsReadUseCase,
      );

      const notification = await markNotificationAsReadUseCase.execute({
        notificationId,
        userId: id,
      });

      return reply.status(200).send({
        message: "Notificação marcada como lida!",
        notification,
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

export { MarkNotificationAsReadController };
