import { inject, injectable } from "tsyringe";
import { UpdateWhatsAppSettingsProps, WhatsAppSettings } from "../../dtos";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { WhatsAppNumberRequiredError } from "../errors/whatsapp-number-required-error";

import { WhatsAppPhoneAlreadyInUseError } from "../errors/whatsapp-phone-already-in-use-error";

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

    if (enabled && !phoneNumber) {
      throw new WhatsAppNumberRequiredError();
    }

    if (enabled && phoneNumber) {
      const userWithSamePhone =
        await this.userRepository.findUserWithWhatsAppByPhone(
          phoneNumber,
          userId,
        );

      if (userWithSamePhone) {
        throw new WhatsAppPhoneAlreadyInUseError();
      }
    }

    // On disable the phone number is kept so re-enabling doesn't require
    // typing it again. The uniqueness check above only considers enabled
    // users, so a kept number never blocks anyone else.
    const storedPhone = enabled ? phoneNumber : user.whatsapp_phone;

    await this.userRepository.updateWhatsAppSettings({
      userId,
      whatsapp_notifications_enabled: enabled,
      whatsapp_phone: storedPhone,
    });

    return {
      enabled,
      phoneNumber: storedPhone || undefined,
      serviceConfigured: this.whatsAppProvider.isConfigured(),
    };
  }
}

export { UpdateWhatsAppSettingsUseCase };
