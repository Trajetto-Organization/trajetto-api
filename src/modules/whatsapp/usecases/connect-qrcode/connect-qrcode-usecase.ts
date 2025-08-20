import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { WhatsAppNotConnectedError } from "../errors/whatsapp-not-connected-error";

import { WhatsAppNumberNotConfiguredError } from "../errors/whatsapp-number-not-configured-error";

import { WhatsAppAlreadyConnectedError } from "../errors/whatsapp-already-connected-error";
import { WhatsAppPhoneAlreadyInUseError } from "../errors/whatsapp-phone-already-in-use-error";

import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";

import { AppError } from "@/shared/errors/AppError";
import { QRCodeData } from "../../dtos";

@injectable()
class ConnectQRCodeUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("WhatsAppProvider")
    private whatsAppProvider: IWhatsAppProvider,
  ) {}

  async execute(userId: string): Promise<QRCodeData> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    if (!user.whatsapp_notifications_enabled) {
      throw new WhatsAppNotConnectedError();
    }

    // Check if there is a configured number
    if (!user.whatsapp_phone) {
      throw new WhatsAppNumberNotConfiguredError();
    }

    // Check if phone number is already being used by another connected user
    const existingConnectedUser =
      await this.userRepository.findUserWithConnectedWhatsAppByPhone(
        user.whatsapp_phone,
      );

    if (existingConnectedUser && existingConnectedUser.id !== userId) {
      throw new WhatsAppPhoneAlreadyInUseError();
    }

    const instanceName = generateWhatsAppInstanceName(
      user.email,
      user.businessId || "master",
    );

    try {
      const status =
        await this.whatsAppProvider.getConnectionStatus(instanceName);

      // If already connected, return informative error
      if (status.status === "connected") {
        throw new WhatsAppAlreadyConnectedError();
      }

      // If instance does not exist, create
      if (status.status === "not_exists") {
        console.log(`[WhatsApp] Criando instância: ${instanceName}`);

        const createResult = await this.whatsAppProvider.createInstance({
          instanceName,
          phoneNumber: user.whatsapp_phone,
        });

        if (!createResult.success) {
          throw new AppError(
            `Erro ao criar instância: ${createResult.message}`,
            500,
          );
        }
      }

      const qrResult = await this.whatsAppProvider.getQRCode(instanceName);

      if (!qrResult.success || !qrResult.data) {
        throw new AppError(`Erro ao gerar QR Code: ${qrResult.message}`, 500);
      }

      console.log(`[WhatsApp] QR Code gerado com sucesso para ${user.email}`);

      return {
        code: qrResult.data.code,
        expiresIn: 300, // 5 minutes
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar gerar o QR Code! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ConnectQRCodeUseCase };
