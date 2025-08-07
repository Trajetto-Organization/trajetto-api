import { inject, injectable } from "tsyringe";
import { WhatsAppSettings } from "../../dtos";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";

@injectable()
class GetWhatsAppSettingsUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("WhatsAppProvider")
    private whatsAppProvider: IWhatsAppProvider,
  ) {}

  async execute(userId: string): Promise<WhatsAppSettings> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    if (user.role !== "BUSINESS_ADMIN") {
      throw new AppError(
        "Apenas administradores de empresa podem gerenciar configurações WhatsApp",
        403,
      );
    }

    const instanceName = generateWhatsAppInstanceName(user.email, user.businessId || "master");

    try {
      // Check connection status if WhatsApp is enabled
      let instanceConnected = false;

      if (user.whatsapp_notifications_enabled && user.whatsapp_phone) {
        try {
          const status =
            await this.whatsAppProvider.getConnectionStatus(instanceName);
          instanceConnected = status.status === "connected";

          // Update status in bank if different
          if (instanceConnected !== user.whatsapp_instance_connected) {
            await this.userRepository.updateWhatsAppInstanceStatus(
              userId,
              instanceConnected,
            );
          }
        } catch (error) {
          console.error(
            "[WhatsApp] Erro ao verificar status da instância:",
            error,
          );
          instanceConnected = false;
        }
      }

      return {
        enabled: user.whatsapp_notifications_enabled || false,
        phoneNumber: user.whatsapp_phone || undefined,
        instanceConnected,
        instanceName,
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar buscar as configurações do WhatsApp! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { GetWhatsAppSettingsUseCase };
