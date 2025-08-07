import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateActivityNotificationsUseCase } from "./update-activity-notifications-usecase";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { updateNotificationsSchema } from "@/schemas/update-notifications-schema";

class UpdateActivityNotificationsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { notification_enabled } = updateNotificationsSchema.parse(
      request.body,
    );

    const updateActivityNotificationsUseCase = container.resolve(
      UpdateActivityNotificationsUseCase,
    );

    try {
      await updateActivityNotificationsUseCase.execute({
        userId: id,
        activity_notifications_enabled: notification_enabled,
      });

      return reply.status(200).send({
        message: "Notificações de atividade atualizadas com sucesso!",
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateActivityNotificationsController };
