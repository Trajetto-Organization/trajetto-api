import { inject, injectable } from "tsyringe";

import "@/modules/notification/container";

import type { IPushDeviceTokenRepository } from "@/modules/notification/repositories/IPush-device-token-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

interface RegisterPushTokenRequest {
  userId: string;

  /** The session (refresh-token family) registering the device. */
  sessionId: string;
  token: string;
  platform: string;
}

/**
 * Registers (or reassigns) a device's Expo push token. The token is unique
 * per DEVICE, not per user: when another account logs into the same phone,
 * the upsert moves the token to the new owner — pushes must follow whoever
 * is signed in, never a previous session.
 *
 * The device is bound to the SESSION too, so ending that session — logout,
 * reuse revocation, a forced logout — unregisters it server-side. The app's
 * own unregister call raced the logout and lost whenever the revoke landed
 * first, and never left at all on a forced or offline logout.
 */
@injectable()
class RegisterPushTokenUseCase {
  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
    @inject("PushDeviceTokenRepository")
    private devices: IPushDeviceTokenRepository,
  ) {}

  async execute({
    userId,
    sessionId,
    token,
    platform,
  }: RegisterPushTokenRequest): Promise<void> {
    const user = await this.userRepository.findUserById(userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    await this.devices.register({ token, platform, userId, sessionId });
  }
}

/**
 * Unregisters a device on logout, best-effort: even if the app never calls
 * this (killed process, offline logout), ending the session deletes the
 * devices it registered, the daily purge drops those of sessions that simply
 * expired, and the upsert-reassignment above and the DeviceNotRegistered
 * pruning in the pipeline keep the rest of the table honest.
 */
@injectable()
class RemovePushTokenUseCase {
  constructor(
    @inject("PushDeviceTokenRepository")
    private devices: IPushDeviceTokenRepository,
  ) {}

  async execute({ userId, token }: { userId: string; token: string }) {
    // Scoped to the caller: one user cannot unregister another's device.
    await this.devices.removeForUser(token, userId);
  }
}

export { RegisterPushTokenUseCase, RemovePushTokenUseCase };
