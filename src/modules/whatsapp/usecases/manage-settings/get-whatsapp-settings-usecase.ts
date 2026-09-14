import { inject, injectable } from "tsyringe";
import { WhatsAppSettings } from "../../dtos";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

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

    return {
      enabled: user.whatsapp_notifications_enabled || false,
      phoneNumber: user.whatsapp_phone || undefined,
      serviceConfigured: this.whatsAppProvider.isConfigured(),
    };
  }
}

export { GetWhatsAppSettingsUseCase };
