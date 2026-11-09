import { inject, injectable } from "tsyringe";

import { hashSecret } from "@/shared/security/bcrypt-gate";
import { NotificationService } from "@/shared/services/notification-service";
import { sendSecurityEventToUser } from "@/websocket";

import { IUserRepository } from "../../repositories/IUser-repository";
import { resolveManagedDriverLogin } from "../../services/managed-driver-login";

interface ResetDriverPasswordProps {
  /** Who asks (the session's user). */
  actorId: string;
  /** The driver's login. */
  userId: string;
  /** The new password, already checked by the login's own rule. */
  password: string;
}

/**
 * The manager sets a new password for a driver's login (plan of 02/11/2026,
 * D2; decision D04) — the driver who forgot it may have no e-mail to reset it
 * by, and the app's "esqueci a senha" says to ask the manager.
 *
 * The same rules as the initial password: a driver's login only, nothing is
 * mailed, the address on file counts as confirmed, and the activity records
 * who did it (never the password). Like any password change, every session
 * of the driver ends — devices and push included — so the phone in the
 * driver's pocket asks for the new one.
 *
 * The manager knows this password (wave 2): the driver must create their own
 * at the next sign-in (`must_change_password`, enforced by the clients). The
 * phones the driver trusts stay trusted — a password never touches that.
 */
@injectable()
class ResetDriverPasswordUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    actorId,
    userId,
    password,
  }: ResetDriverPasswordProps): Promise<void> {
    const { target } = await resolveManagedDriverLogin(
      this.user,
      actorId,
      userId,
    );

    const hashedPassword = await hashSecret(password, 10);

    await this.user.updateUserPassword({
      userId: target.id,
      password: hashedPassword,
      markEmailVerifiedAt: target.email_verified ? undefined : new Date(),
      mustChangePassword: true,
    });

    sendSecurityEventToUser(target.id, { reason: "password_reset" });

    this.notificationService.createActivityIfEnabled({
      type: "Usuário",
      action: "update",
      entityId: target.id,
      description: `Senha do motorista ${target.name} redefinida pelo gestor`,
      status: "Atualizado",
      performedBy: actorId,
      businessId: target.businessId ?? null,
    });
  }
}

export { ResetDriverPasswordUseCase };
