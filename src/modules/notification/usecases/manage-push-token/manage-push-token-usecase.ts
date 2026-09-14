import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

interface RegisterPushTokenRequest {
  userId: string;
  token: string;
  platform: string;
}

/**
 * Registers (or reassigns) a device's Expo push token. The token is unique
 * per DEVICE, not per user: when another account logs into the same phone,
 * the upsert moves the token to the new owner — pushes must follow whoever
 * is signed in, never a previous session.
 */
@injectable()
class RegisterPushTokenUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
  ) {}

  async execute({
    userId,
    token,
    platform,
  }: RegisterPushTokenRequest): Promise<void> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    await database.pushDeviceToken.upsert({
      where: { token },
      create: { token, platform, userId },
      update: { platform, userId },
    });
  }
}

/**
 * Unregisters a device on logout, best-effort: even if the app never calls
 * this (killed process, offline logout), the upsert-reassignment above and
 * the DeviceNotRegistered pruning in the pipeline keep the table honest.
 */
@injectable()
class RemovePushTokenUseCase {
  async execute({ userId, token }: { userId: string; token: string }) {
    // Scoped to the caller: one user cannot unregister another's device.
    await database.pushDeviceToken.deleteMany({
      where: { token, userId },
    });
  }
}

export { RegisterPushTokenUseCase, RemovePushTokenUseCase };
