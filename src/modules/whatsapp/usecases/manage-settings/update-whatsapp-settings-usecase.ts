import { inject, injectable } from "tsyringe";
import { UpdateWhatsAppSettingsProps, WhatsAppSettings } from "../../dtos";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { WhatsAppNumberRequiredError } from "../errors/whatsapp-number-required-error";

import { WhatsAppPhoneUpdateNotAllowedError } from "../errors/whatsapp-phone-update-not-allowed-error";
import { WhatsAppPhoneAlreadyInUseError } from "../errors/whatsapp-phone-already-in-use-error";

import { WhatsAppBusinessInstanceNotFoundError } from "../errors/whatsapp-business-instance-not-found-error";
import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";

import { WhatsAppBusinessNotConnected } from "../errors/whatsapp-business-not-connected-error";
import { WhatsAppWebhookController } from "../webhook/whatsapp-webhook-controller";

import { AppError } from "@/shared/errors/AppError";
import { env } from "@/env";

@injectable()
class UpdateWhatsAppSettingsUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("WhatsAppProvider")
    private whatsAppProvider: IWhatsAppProvider,
  ) {}

  async execute({
    userId,
    enabled,
    phoneNumber,
  }: UpdateWhatsAppSettingsProps): Promise<WhatsAppSettings> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    const isPhoneChanging =
      phoneNumber && user.whatsapp_phone && phoneNumber !== user.whatsapp_phone;

    if (isPhoneChanging && user.whatsapp_notifications_enabled && enabled) {
      throw new WhatsAppPhoneUpdateNotAllowedError();
    }

    if (enabled && !phoneNumber) {
      throw new WhatsAppNumberRequiredError();
    }

    // Check if business instance exists when enabling WhatsApp
    if (enabled) {
      const businessInstanceName = env.TRAJETTO_WHATSAPP_INSTANCE_NAME;

      try {
        const businessInstanceStatus =
          await this.whatsAppProvider.getConnectionStatus(businessInstanceName);

        if (businessInstanceStatus.status === "not_exists") {
          throw new WhatsAppBusinessInstanceNotFoundError();
        }

        if (businessInstanceStatus.status !== "connected") {
          throw new WhatsAppBusinessNotConnected();
        }
      } catch (error: any) {
        // If it's a 404 error, the instance doesn't exist
        if (error.response?.status === 404) {
          throw new WhatsAppBusinessInstanceNotFoundError();
        }
        // Re-throw our custom errors
        if (
          error instanceof WhatsAppBusinessInstanceNotFoundError ||
          error instanceof AppError
        ) {
          throw error;
        }
        // For other errors, let them pass through to maintain existing behavior
        console.log(
          "[WhatsApp] Error checking business instance, proceeding anyway:",
          error.message,
        );
      }
    }

    // Check if phone number is already being used by another connected user
    if (enabled && phoneNumber) {
      const existingConnectedUser =
        await this.userRepository.findUserWithConnectedWhatsAppByPhone(
          phoneNumber,
        );

      if (existingConnectedUser && existingConnectedUser.id !== userId) {
        throw new WhatsAppPhoneAlreadyInUseError();
      }
    }

    // Use per-user instance names
    const instanceName = generateWhatsAppInstanceName(
      user.email,
      user.businessId as string,
    );

    try {
      // Process based on action
      if (!enabled) {
        // Record disable operation
        WhatsAppWebhookController.registerUserOperation(
          userId,
          "disabling",
          instanceName,
        );

        // 🔴 DISABLE WhatsApp - KEEP phone number for easy reactivation
        return await this.disableWhatsApp(
          userId,
          user.whatsapp_phone || phoneNumber,
          instanceName,
        );
      } else {
        // Record enable/re-create operation
        const operation = isPhoneChanging ? "recreating" : "enabling";
        WhatsAppWebhookController.registerUserOperation(
          userId,
          operation,
          instanceName,
        );

        // 🟢 ENABLE WhatsApp
        return await this.enableWhatsApp(
          userId,
          phoneNumber!,
          instanceName,
          user,
        );
      }
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar as configurações do WhatsApp! Por favor, tente novamente.",
        500,
      );
    }
  }

  /**
   * 🔴 Disable WhatsApp and disconnect instance - KEEP phone number
   */
  private async disableWhatsApp(
    userId: string,
    phoneNumber?: string,
    instanceName?: string,
  ): Promise<WhatsAppSettings> {
    console.log(`[WhatsApp] 🔴 Disabling WhatsApp for user: ${userId}`);

    // Update settings in database - KEEP the phone number for easy reconfiguration
    // This also automatically "releases" the number for other users since
    // whatsapp_notifications_enabled becomes false
    await this.userRepository.updateWhatsAppSettings({
      userId,
      whatsapp_notifications_enabled: false,
      whatsapp_phone: phoneNumber, // KEEP the number for easy reconfiguration
    });

    // Update connection status to false immediately
    await this.userRepository.updateWhatsAppInstanceStatus(userId, false);

    // Disconnect instance asynchronously (non-blocking)
    if (instanceName) {
      this.disconnectInstanceAsync(instanceName, userId);
    }

    console.log(
      `[WhatsApp] 📞 Phone number ${phoneNumber} released for other users`,
    );

    return {
      enabled: false,
      phoneNumber, // Return the phone number instead of undefined
      instanceConnected: false,
      instanceName: instanceName || "",
    };
  }

  /**
   * 🟢 Enable WhatsApp and configure instance
   */
  private async enableWhatsApp(
    userId: string,
    phoneNumber: string,
    instanceName: string,
    user: any,
  ): Promise<WhatsAppSettings> {
    console.log(`[WhatsApp] 🟢 Enabling WhatsApp for user: ${userId}`);

    // Update settings in the bank first
    await this.userRepository.updateWhatsAppSettings({
      userId,
      whatsapp_notifications_enabled: true,
      whatsapp_phone: phoneNumber,
    });

    // Check if the number has changed
    const phoneChanged = user.whatsapp_phone !== phoneNumber;

    if (!phoneChanged && user.whatsapp_phone) {
      // If the number hasn't changed, just check the status.
      try {
        const status =
          await this.whatsAppProvider.getConnectionStatus(instanceName);

        if (status.status === "connected") {
          await this.userRepository.updateWhatsAppInstanceStatus(userId, true);

          return {
            enabled: true,
            phoneNumber,
            instanceConnected: true,
            instanceName,
          };
        }
      } catch (error) {
        console.log(
          "[WhatsApp] Instance doesn't exist or error checking status",
        );
      }
    }

    // For user instance, just check connection status without recreating
    this.checkUserInstanceAsync(instanceName, userId);

    return {
      enabled: true,
      phoneNumber,
      instanceConnected: false, // Always false initially
      instanceName,
    };
  }

  /**
   * 👤 Check user instance connection status without recreation
   */
  private async checkUserInstanceAsync(
    instanceName: string,
    userId: string,
  ): Promise<void> {
    try {
      console.log(
        `[WhatsApp] 🔍 Checking user instance status: ${instanceName}`,
      );

      // Add small delay to avoid conflicts
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check current connection status
      const status =
        await this.whatsAppProvider.getConnectionStatus(instanceName);
      const isConnected = status.status === "connected";

      // Update user's connection status in database
      await this.userRepository.updateWhatsAppInstanceStatus(
        userId,
        isConnected,
      );

      console.log(
        `[WhatsApp] ✅ User instance check complete. Status: ${isConnected ? "conectado" : "desconectado"}`,
      );

      if (!isConnected) {
        console.log(
          `[WhatsApp] ⚠️ User instance not connected. User needs to scan QR code.`,
        );
      }
    } catch (error) {
      console.error(`[WhatsApp] ❌ Error checking user instance:`, error);
      await this.userRepository.updateWhatsAppInstanceStatus(userId, false);
    }
  }

  /**
   * 🔌 Disconnect instance asynchronously with better error handling
   */
  private async disconnectInstanceAsync(
    instanceName: string,
    userId: string,
  ): Promise<void> {
    try {
      console.log(`[WhatsApp] 🔌 Disconnecting instance: ${instanceName}`);

      // Add delay to avoid conflicts
      await new Promise((resolve) => setTimeout(resolve, 500));

      await this.whatsAppProvider.disconnectInstance(instanceName);
      console.log(`[WhatsApp] ✅ Instance disconnected successfully`);
    } catch (error) {
      console.log(
        "[WhatsApp] ℹ️ Instance was already disconnected or error disconnecting",
      );
    }
  }
}

export { UpdateWhatsAppSettingsUseCase };
