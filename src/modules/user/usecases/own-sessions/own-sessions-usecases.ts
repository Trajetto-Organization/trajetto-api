import { inject, injectable } from "tsyringe";

import { NotificationService } from "@/shared/services/notification-service";
import { sendSecurityEventToSession } from "@/websocket";

import type { UserOwnSession } from "../../dtos/user-tokens-dto";
import { IDriverEnrollmentRepository } from "../../repositories/IDriver-enrollment-repository";
import { IDriverTrustedDeviceRepository } from "../../repositories/IDriver-trusted-device-repository";
import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { hashDeviceId } from "../../services/session-service";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { SessionIsCurrentError } from "../errors/session-is-current-error";

/** One of the person's sessions, as "Aparelhos conectados" shows it. */
interface OwnSessionView {
  id: string;
  kind: UserOwnSession["kind"];
  current: boolean;
  created_at: Date;
  last_activity_at: Date;
  /** "Este aparelho" for the session asking; null for the others. */
  device_label: string | null;
}

const CURRENT_DEVICE_LABEL = "Este aparelho";

/**
 * GET /user/me/sessions: the person's own sessions (wave 2, 06/11/2026), every
 * login still live — the phone-bound ones, the app by e-mail, the browsers —
 * most recently used first. The only list there was is the manager's, of a
 * driver's phones; nobody could see their own. No phone id ever leaves: the
 * session's id and its kind say enough to recognize it.
 */
@injectable()
class ListOwnSessionsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute({
    userId,
    sessionId,
  }: {
    userId: string;
    sessionId: string;
  }): Promise<OwnSessionView[]> {
    const user = await this.user.findUserById(userId);

    if (!user) throw new ResourceNotFoundError();

    const sessions = await this.usersTokens.listUserSessions(user.id);

    return sessions.map((session) => {
      const current = session.family_id === sessionId;

      return {
        id: session.family_id,
        kind: session.kind,
        current,
        created_at: session.created_at,
        last_activity_at: session.last_activity_at,
        device_label: current ? CURRENT_DEVICE_LABEL : null,
      };
    });
  }
}

/**
 * DELETE /user/me/sessions/:id: the person ends one of their other sessions —
 * its refresh tokens and the push devices it registered — and its open
 * sockets are told (`logout`: a reason both clients already end the session
 * on, with their generic words, where a new one would fail the app's check
 * of the reasons the API sends until it has words of its own).
 *
 * A phone-bound session takes the phone's trust with it — and the consumed
 * QR code's record of that phone — once nothing of the person is left on
 * it: that phone needs a new QR code to sign in by CPF again, as when the
 * manager disconnects it. A phone often holds two sessions (a logout without
 * signal, or cleared app data, leaves the old one alive, and the Android ID
 * survives a reinstall): ending the stale one from the phone itself must not
 * cost that phone its CPF login.
 *
 * This session itself is refused (409 SESSION_IS_CURRENT; the logout is its
 * way out). Scoped by the person: a session that is not theirs, or already
 * over, ends nothing and gets the same 204, as the manager's revoke does.
 */
@injectable()
class RevokeOwnSessionUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("DriverTrustedDeviceRepository")
    private trustedDevices: IDriverTrustedDeviceRepository,
    @inject("DriverEnrollmentRepository")
    private enrollment: IDriverEnrollmentRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    sessionId,
    targetId,
  }: {
    userId: string;
    /** The session asking. */
    sessionId: string;
    /** The session to end. */
    targetId: string;
  }): Promise<void> {
    if (targetId === sessionId) throw new SessionIsCurrentError();

    const user = await this.user.findUserById(userId);

    if (!user) throw new ResourceNotFoundError();

    const { ended, deviceId } = await this.usersTokens.revokeUserSession(
      user.id,
      targetId,
    );

    if (!ended) return;

    const phoneLeft =
      deviceId !== null && !(await this.stillOnPhone(user.id, deviceId));

    if (phoneLeft) {
      await this.trustedDevices.revoke(user.id, hashDeviceId(deviceId));
      await this.enrollment.forgetDevice(user.id, deviceId);
    }

    sendSecurityEventToSession(targetId, { reason: "logout" });

    this.notificationService.createActivityIfEnabled({
      type: "Usuário",
      action: "update",
      entityId: user.id,
      description: phoneLeft
        ? `Aparelho de ${user.name} desconectado pelo próprio usuário`
        : `Sessão de ${user.name} encerrada pelo próprio usuário`,
      status: "Atualizado",
      performedBy: user.id,
      businessId: user.businessId ?? null,
    });
  }

  /**
   * Whether another live session of the person is still bound to the phone
   * — the one asking among them, when it runs on that phone.
   */
  private async stillOnPhone(
    userId: string,
    deviceId: string,
  ): Promise<boolean> {
    const phones = await this.usersTokens.listUserDeviceSessions(userId);
    const deviceHash = hashDeviceId(deviceId);

    return phones.some((phone) => phone.device_hash === deviceHash);
  }
}

export {
  CURRENT_DEVICE_LABEL,
  ListOwnSessionsUseCase,
  RevokeOwnSessionUseCase,
};
export type { OwnSessionView };
