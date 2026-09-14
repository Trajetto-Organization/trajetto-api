import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { GetNotificationPreferencesUseCase } from "./get-notification-preferences-usecase";
import { UpdateNotificationPreferencesUseCase } from "./update-notification-preferences-usecase";

import { updateNotificationPreferencesSchema } from "@/schemas/notification-preferences-schema";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class NotificationPreferencesController {
  async getPreferences(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;

    try {
      const getPreferencesUseCase = container.resolve(
        GetNotificationPreferencesUseCase,
      );

      const preferences = await getPreferencesUseCase.execute(userId);

      return reply.status(200).send({ preferences });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }

  async updatePreferences(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;
    const { preferences } = updateNotificationPreferencesSchema.parse(
      request.body,
    );

    try {
      const updatePreferencesUseCase = container.resolve(
        UpdateNotificationPreferencesUseCase,
      );

      await updatePreferencesUseCase.execute(userId, preferences);

      return reply
        .status(200)
        .send({ message: "Preferências de notificação atualizadas!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { NotificationPreferencesController };
