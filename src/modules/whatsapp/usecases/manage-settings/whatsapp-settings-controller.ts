import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { GetWhatsAppSettingsUseCase } from "./get-whatsapp-settings-usecase";
import { UpdateWhatsAppSettingsUseCase } from "./update-whatsapp-settings-usecase";

import { updateWhatsAppSettingsSchema } from "@/schemas/phone-validation-schema";

import { WhatsAppNumberRequiredError } from "../errors/whatsapp-number-required-error";
import { WhatsAppPhoneUpdateNotAllowedError } from "../errors/whatsapp-phone-update-not-allowed-error";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { WhatsAppPhoneAlreadyInUseError } from "../errors/whatsapp-phone-already-in-use-error";

import { WhatsAppBusinessInstanceNotFoundError } from "../errors/whatsapp-business-instance-not-found-error";
import { WhatsAppBusinessNotConnected } from "../errors/whatsapp-business-not-connected-error";

class WhatsAppSettingsController {
  async getSettings(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;

    try {
      const getSettingsUseCase = container.resolve(GetWhatsAppSettingsUseCase);
      const settings = await getSettingsUseCase.execute(userId);

      return reply.status(200).send({
        success: true,
        message: "Configurações obtidas com sucesso",
        data: settings,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }

  async updateSettings(request: FastifyRequest, reply: FastifyReply) {
    const { id: userId } = request.user;
    const { whatsapp_notifications_enabled, whatsapp_phone } =
      updateWhatsAppSettingsSchema.parse(request.body);

    try {
      const updateSettingsUseCase = container.resolve(
        UpdateWhatsAppSettingsUseCase,
      );

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
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof WhatsAppBusinessInstanceNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      if (error instanceof WhatsAppBusinessNotConnected) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof WhatsAppNumberRequiredError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof WhatsAppPhoneUpdateNotAllowedError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof WhatsAppPhoneAlreadyInUseError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { WhatsAppSettingsController };
