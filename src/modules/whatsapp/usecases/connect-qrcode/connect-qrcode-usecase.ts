import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { WhatsAppNotConnectedError } from "../errors/whatsapp-not-connected-error";

import { WhatsAppNumberNotConfiguredError } from "../errors/whatsapp-number-not-configured-error";
import { WhatsAppAlreadyConnectedError } from "../errors/whatsapp-already-connected-error";

import { WhatsAppPhoneAlreadyInUseError } from "../errors/whatsapp-phone-already-in-use-error";
import { WhatsAppBusinessInstanceNotFoundError } from "../errors/whatsapp-business-instance-not-found-error";

import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";
import { env } from "@/env";

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

    // Check if business instance exists and is connected before allowing user to create their own instance
    const businessInstanceName = env.TRAJETTO_WHATSAPP_INSTANCE_NAME;
    try {
      const businessStatus =
        await this.whatsAppProvider.getConnectionStatus(businessInstanceName);
      if (businessStatus.status === "not_exists") {
        throw new WhatsAppBusinessInstanceNotFoundError();
      }
      if (businessStatus.status !== "connected") {
        throw new AppError(
          "A instância de negócio do WhatsApp não está conectada. Entre em contato com o suporte.",
          400,
        );
      }
    } catch (error: any) {
      if (error.response?.status === 404) {
        throw new WhatsAppBusinessInstanceNotFoundError();
      }
      if (
        error instanceof WhatsAppBusinessInstanceNotFoundError ||
        error instanceof AppError
      ) {
        throw error;
      }
    }

    // Generate user-specific instance name
    const instanceName = generateWhatsAppInstanceName(
      user.email,
      user.businessId as string,
    );

    try {
      const status =
        await this.whatsAppProvider.getConnectionStatus(instanceName);

      // If already connected, return informative error
      if (status.status === "connected") {
        throw new WhatsAppAlreadyConnectedError();
      }

      // If user instance does not exist, create it
      if (status.status === "not_exists") {
        console.log(`[WhatsApp] Criando instância do usuário: ${instanceName}`);

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
    } catch (error: any) {
      // If it's a 404 error, the business instance doesn't exist
      if (error.response?.status === 404) {
        throw new WhatsAppBusinessInstanceNotFoundError();
      }

      // If it's one of our custom errors, re-throw it
      if (
        error instanceof WhatsAppAlreadyConnectedError ||
        error instanceof WhatsAppBusinessInstanceNotFoundError
      ) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar gerar o QR Code! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { ConnectQRCodeUseCase };
