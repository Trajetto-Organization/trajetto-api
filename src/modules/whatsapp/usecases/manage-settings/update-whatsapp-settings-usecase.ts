import { inject, injectable } from "tsyringe";
import { UpdateWhatsAppSettingsProps, WhatsAppSettings } from "../../dtos";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { WhatsAppNumberRequiredError } from "../errors/whatsapp-number-required-error";

import { WhatsAppPhoneUpdateNotAllowedError } from "../errors/whatsapp-phone-update-not-allowed-error";
import { WhatsAppPhoneAlreadyInUseError } from "../errors/whatsapp-phone-already-in-use-error";

import { AppError } from "@/shared/errors/AppError";
import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";

import { WhatsAppWebhookController } from "../webhook/whatsapp-webhook-controller";

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

    if (user.role !== "BUSINESS_ADMIN") {
      throw new AppError(
        "Apenas administradores de empresa podem gerenciar configurações WhatsApp",
        403,
      );
    }

    const isPhoneChanging =
      phoneNumber && user.whatsapp_phone && phoneNumber !== user.whatsapp_phone;

    if (isPhoneChanging && user.whatsapp_notifications_enabled && enabled) {
      throw new WhatsAppPhoneUpdateNotAllowedError();
    }

    if (enabled && !phoneNumber) {
      throw new WhatsAppNumberRequiredError();
    }

    // Check if phone number is already being used by another connected user
    if (enabled && phoneNumber) {
      const existingConnectedUser = await this.userRepository.findUserWithConnectedWhatsAppByPhone(phoneNumber);
      
      if (existingConnectedUser && existingConnectedUser.id !== userId) {
        throw new WhatsAppPhoneAlreadyInUseError();
      }
    }

    const instanceName = generateWhatsAppInstanceName(
      user.email,
      user.businessId || "master",
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

    console.log(`[WhatsApp] 📞 Phone number ${phoneNumber} released for other users`);

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

    // Configure instance asynchronously
    this.setupInstanceAsync(instanceName, phoneNumber, userId, phoneChanged);

    return {
      enabled: true,
      phoneNumber,
      instanceConnected: false, // Always false initially
      instanceName,
    };
  }

  /**
   * ⚡ Configure instance asynchronously with better error handling
   */
  private async setupInstanceAsync(
    instanceName: string,
    phoneNumber: string,
    userId: string,
    recreateInstance: boolean,
  ): Promise<void> {
    try {
      console.log(`[WhatsApp] 🔧 Setting up async instance: ${instanceName}`);

      // Add delay to avoid conflicts with rapid toggles
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Delete instance if necessary
      if (recreateInstance) {
        console.log(`[WhatsApp] 🗑️ Deleting existing instance for recreation`);
        try {
          await this.whatsAppProvider.deleteInstance(instanceName);
          // Wait a bit after deleting to avoid conflicts
          await new Promise((resolve) => setTimeout(resolve, 3000)); // INCREASED to 3 seconds
        } catch (error) {
          console.log(`[WhatsApp] ℹ️ No instance to delete or already deleted`);
        }
      }

      // Check if instance exists
      const status =
        await this.whatsAppProvider.getConnectionStatus(instanceName);

      if (status.status === "not_exists" || recreateInstance) {
        console.log(`[WhatsApp] 🆕 Creating new instance`);

        const createResult = await this.whatsAppProvider.createInstance({
          instanceName,
          phoneNumber,
        });

        if (!createResult.success) {
          console.error(
            `[WhatsApp] ❌ Error creating instance: ${createResult.message}`,
          );
          return;
        }

        console.log(`[WhatsApp] ✅ Instance created successfully`);
      }

      // Wait longer before checking final status
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check final status
      const finalStatus =
        await this.whatsAppProvider.getConnectionStatus(instanceName);
      const isConnected = finalStatus.status === "connected";

      // Update status in database
      await this.userRepository.updateWhatsAppInstanceStatus(
        userId,
        isConnected,
      );

      console.log(
        `[WhatsApp] ✅ Setup completo. Status final: ${isConnected ? "conectado" : "desconectado"}`,
      );
    } catch (error) {
      console.error(`[WhatsApp] ❌ Error in setupInstanceAsync:`, error);
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
