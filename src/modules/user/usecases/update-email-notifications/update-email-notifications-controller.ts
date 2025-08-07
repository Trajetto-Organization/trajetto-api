import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateEmailNotificationsUseCase } from "./update-email-notifications-usecase";
import { updateNotificationsSchema } from "@/schemas/update-notifications-schema";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";

class UpdateEmailNotificationsController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { notification_enabled } = updateNotificationsSchema.parse(
      request.body,
    );

    const updateEmailNotificationsUseCase = container.resolve(
      UpdateEmailNotificationsUseCase,
    );

    try {
      await updateEmailNotificationsUseCase.execute({
        userId: id,
        email_notifications_enabled: notification_enabled,
      });

      return reply.status(200).send({
        message: "Notificações por e-mail atualizadas com sucesso!",
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateEmailNotificationsController };
