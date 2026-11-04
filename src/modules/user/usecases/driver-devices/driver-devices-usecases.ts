import { inject, injectable } from "tsyringe";

import { NotificationService } from "@/shared/services/notification-service";
import { sendSecurityEventToSession } from "@/websocket";

import { UserDeviceSession } from "../../dtos/user-tokens-dto";
import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { resolveManagedDriverLogin } from "../../services/managed-driver-login";

interface DriverDevicesProps {
  /** Who asks (the session's user). */
  actorId: string;
  /** The driver's login. */
  userId: string;
}

/**
 * The phones a driver is signed in on (plan of 02/11/2026, D7): the sessions
 * opened by the QR code or by CPF and password, which are bound to the phone
 * that opened them (D4). A lost or stolen phone keeps its session for up to
 * 30 idle days, so the manager needs to see it and end it.
 */
@injectable()
class ListDriverDevicesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute({
    actorId,
    userId,
  }: DriverDevicesProps): Promise<UserDeviceSession[]> {
    const { target } = await resolveManagedDriverLogin(
      this.user,
      actorId,
      userId,
    );

    return this.usersTokens.listUserDeviceSessions(target.id);
  }
}

/**
 * "Revogar este aparelho": every session of the driver on that phone ends at
 * once — refresh tokens and the push devices they registered, so the phone
 * stops receiving the driver's messages too — and its open sockets are told
 * (`device_revoked`, which ends the session there). The driver's other
 * phones are left alone. Idempotent: a phone already gone ends nothing and
 * gets the same answer.
 */
@injectable()
class RevokeDriverDeviceUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    actorId,
    userId,
    deviceId,
  }: DriverDevicesProps & { deviceId: string }): Promise<void> {
    const { target } = await resolveManagedDriverLogin(
      this.user,
      actorId,
      userId,
    );

    const ended = await this.usersTokens.revokeUserDeviceSessions(
      target.id,
      deviceId,
    );

    if (ended.length === 0) return;

    for (const familyId of ended) {
      sendSecurityEventToSession(familyId, { reason: "device_revoked" });
    }

    this.notificationService.createActivityIfEnabled({
      type: "Usuário",
      action: "update",
      entityId: target.id,
      description: `Aparelho do motorista ${target.name} desconectado pelo gestor`,
      status: "Atualizado",
      performedBy: actorId,
      businessId: target.businessId ?? null,
    });
  }
}

export { ListDriverDevicesUseCase, RevokeDriverDeviceUseCase };
