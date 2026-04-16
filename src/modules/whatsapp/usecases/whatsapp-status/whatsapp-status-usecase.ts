import { inject, injectable } from "tsyringe";
import { ConnectionInfo } from "../../dtos";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { WhatsAppNotConnectedError } from "../errors/whatsapp-not-connected-error";

import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";

@injectable()
class WhatsAppStatusUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("WhatsAppProvider")
    private whatsAppProvider: IWhatsAppProvider,
  ) {}

  async execute(userId: string): Promise<ConnectionInfo> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    if (!user.whatsapp_notifications_enabled) {
      throw new WhatsAppNotConnectedError();
    }

    const instanceName = generateWhatsAppInstanceName(
      user.email,
      user.businessId as string,
    );

    try {
      console.log(
        `[WhatsApp] 🔄 Verificando status da instância: ${instanceName}`,
      );

      // Check the current status in the Evolution API
      const status =
        await this.whatsAppProvider.getConnectionStatus(instanceName);

      const isConnected = status.status === "connected";

      // Updates the status in the database if it is different
      if (isConnected !== user.whatsapp_instance_connected) {
        try {
          await this.userRepository.updateWhatsAppInstanceStatus(
            userId,
            isConnected,
          );

          console.log(
            `[WhatsApp] ✅ Status atualizado no banco: ${isConnected}`,
          );
        } catch (error) {
          console.error(
            `[WhatsApp] ⚠️ Erro ao atualizar status no banco:`,
            error,
          );
          // Continue execution even if database update fails
        }
      }

      const connectionInfo: ConnectionInfo = {
        instanceName,
        status: status.status,
        phoneNumber: user.whatsapp_phone || undefined,
        qrCodeAvailable: status.status === "disconnected",
        pairingCodeAvailable: false, // Not implemented yet
      };

      console.log(`[WhatsApp] 📊 Status verificado:`, connectionInfo);

      return connectionInfo;
    } catch (error) {
      console.error(`[WhatsApp] ❌ Erro ao verificar status:`, error);

      // If there was an error, the instance probably does not exist.
      await this.userRepository.updateWhatsAppInstanceStatus(userId, false);

      return {
        instanceName,
        status: "not_exists",
        phoneNumber: user.whatsapp_phone || undefined,
        qrCodeAvailable: true,
        pairingCodeAvailable: false,
      };
    }
  }
}

export { WhatsAppStatusUseCase };
