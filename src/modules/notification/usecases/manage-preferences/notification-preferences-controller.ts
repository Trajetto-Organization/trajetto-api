import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { GetNotificationPreferencesUseCase } from "./get-notification-preferences-usecase";
import { UpdateNotificationPreferencesUseCase } from "./update-notification-preferences-usecase";
import { updateNotificationPreferencesSchema } from "@/schemas/notification-preferences-schema";
import { OpsAlertPreferenceUseCase } from "@/modules/chat/usecases/ops-alert-preference/ops-alert-preference-usecase";

class NotificationPreferencesController {
  async getPreferences(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;

    const getPreferencesUseCase = container.resolve(
      GetNotificationPreferencesUseCase,
    );

    const preferences = await getPreferencesUseCase.execute(userId);

    // Decision 14.6: the alert sound rides the same screen.
    const opsAlert = await container.resolve(OpsAlertPreferenceUseCase).get(userId);

    return reply.status(200).send({ preferences, opsAlert });
  }

  async updatePreferences(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;
    const { preferences, opsAlert } = updateNotificationPreferencesSchema.parse(
      request.body,
    );

    // Either part may come alone (decision 14.6: the alert sound is saved by
    // itself from the operations balloon).
    if (preferences) {
      const updatePreferencesUseCase = container.resolve(
        UpdateNotificationPreferencesUseCase,
      );

      await updatePreferencesUseCase.execute(userId, preferences);
    }

    if (opsAlert) {
      await container.resolve(OpsAlertPreferenceUseCase).update(userId, opsAlert);
    }

    return reply
      .status(200)
      .send({ message: "Preferências de notificação atualizadas!" });
  }
}

export { NotificationPreferencesController };
