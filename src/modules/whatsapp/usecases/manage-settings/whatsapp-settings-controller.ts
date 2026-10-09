import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";
import { GetWhatsAppSettingsUseCase } from "./get-whatsapp-settings-usecase";
import { UpdateWhatsAppSettingsUseCase } from "./update-whatsapp-settings-usecase";
import { updateWhatsAppSettingsSchema } from "@/schemas/phone-validation-schema";

class WhatsAppSettingsController {
  async getSettings(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;

    const getSettingsUseCase = container.resolve(GetWhatsAppSettingsUseCase);
    const settings = await getSettingsUseCase.execute(userId);

    return reply.status(200).send({
      success: true,
      message: "Configurações obtidas com sucesso",
      data: settings,
    });
  }

  async updateSettings(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;
    const { whatsapp_notifications_enabled, whatsapp_phone } =
      updateWhatsAppSettingsSchema.parse(request.body);

    const updateSettingsUseCase = container.resolve(
      UpdateWhatsAppSettingsUseCase,
    );

    // Refusals are AppErrors (400 WHATSAPP_NUMBER_REQUIRED, 409
    // WHATSAPP_PHONE_TAKEN, 404 USER_NOT_FOUND) answered by the global handler.
    const settings = await updateSettingsUseCase.execute({
      userId,
      enabled: whatsapp_notifications_enabled,
      phoneNumber: whatsapp_phone,
    });

    return reply.status(200).send({
      success: true,
      message: `WhatsApp ${whatsapp_notifications_enabled ? "habilitado" : "desabilitado"} com sucesso`,
      data: settings,
    });
  }
}

export { WhatsAppSettingsController };
