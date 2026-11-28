import { inject, injectable } from "tsyringe";

import { hashSecret } from "@/shared/security/bcrypt-gate";
import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";
import { NotificationService } from "@/shared/services/notification-service";
import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";

import type { DriverEnrollmentToken } from "../../dtos/driver-enrollment-dto";
import type { UserSessionFamily } from "../../dtos/user-tokens-dto";
import { IDriverEnrollmentRepository } from "../../repositories/IDriver-enrollment-repository";
import {
  IUserRepository,
  KeptSessionEndedError,
} from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import {
  type KeptSessionTokens,
  setPasswordKeepingSession,
} from "../../services/password-session";
import {
  type HeaderSessionClient,
  familyStartedAtOf,
} from "../../services/session-service";

import { PasswordCreateNotAllowedError } from "../errors/password-create-not-allowed-error";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

const log = logger.child({ component: "user" });

/**
 * How long after the QR code was read the password may be created without
 * the current one: the driver creates it right away, on the screen the QR
 * opened. Longer would leave a stolen phone a way to take the account over.
 */
const CREATE_AFTER_QR_WINDOW_MS = 15 * 60 * 1000;

/**
 * The QR's consumption is stamped by the API's clock and the session's first
 * row by the database's: a few seconds apart at most.
 */
const CLOCK_SKEW_MS = 30 * 1000;

interface CreateOwnPasswordProps {
  userId: string;
  /** The caller's session (the access token's refresh family). */
  sessionId: string;
  /** Already checked by the same rule as a password change. */
  password: string;
  /** What the request's x-trajetto-client header asks for. */
  client?: HeaderSessionClient;
}

type CreatedOwnPassword = KeptSessionTokens & { mustChangePassword: false };

/**
 * Whether this session is the one the login's QR code just opened (wave 2):
 * the code was consumed within the window, on the phone this session is
 * bound to, and the session began with it — not one that existed before it.
 * Nothing links the two rows, so all three facts together are the link: the
 * phone's id is the session's, and only a QR or a CPF login on that phone,
 * after that moment, could have opened it.
 */
function isSessionOpenedByQr(
  enrollment: DriverEnrollmentToken | null,
  family: UserSessionFamily | null,
  now: Date,
): boolean {
  if (!enrollment?.consumed_at || !enrollment.device_id || !family) {
    return false;
  }

  const consumedAt = enrollment.consumed_at.getTime();

  // The session began at the earlier of its id's birth (UUIDv7) and its
  // oldest stored row: a password change re-issues the session and deletes
  // its live row, so a session that never renewed would otherwise look as
  // young as that re-issue.
  const bornAt = familyStartedAtOf(family.family_id);
  const startedAt = Math.min(
    family.first_issued_at.getTime(),
    bornAt === null ? Number.POSITIVE_INFINITY : bornAt * 1000,
  );

  return (
    family.device_id === enrollment.device_id &&
    now.getTime() - consumedAt <= CREATE_AFTER_QR_WINDOW_MS &&
    startedAt >= consumedAt - CLOCK_SKEW_MS
  );
}

/**
 * POST /user/me/password: the driver creates a password right after entering
 * by the manager's QR code, without a current one (wave 2, 06/11/2026;
 * owner's decision: "esqueci a senha" without e-mail is a new QR code from
 * the manager, then the driver creates the password at once).
 *
 * Only the session that QR opened may do it, within fifteen minutes; any
 * other refuses with 403 PASSWORD_CREATE_NOT_ALLOWED (the change with the
 * current password is PATCH /user/password). Like that change, it keeps this
 * session and ends every other — the lock somebody keeps renewing by guessing
 * the CPF is cleared, and the manager's "create your own" flag with it.
 *
 * A code read out over the phone is how somebody posing as the driver would
 * take the account: the activity records it and the company's admins hear
 * it, all but the manager who issued the code, in the password's
 * transaction.
 */
@injectable()
class CreateOwnPasswordUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("DriverEnrollmentRepository")
    private enrollment: IDriverEnrollmentRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    sessionId,
    password,
    client = "web",
  }: CreateOwnPasswordProps): Promise<CreatedOwnPassword> {
    const user = await this.user.findUserById(userId);

    if (!user) throw new ResourceNotFoundError();

    const now = new Date();
    const [enrollment, family] = await Promise.all([
      this.enrollment.findByUserId(user.id),
      this.usersTokens.findSessionFamily(user.id, sessionId, now),
    ]);

    if (!family || !isSessionOpenedByQr(enrollment, family, now)) {
      throw new PasswordCreateNotAllowedError();
    }

    const passwordHash = await hashSecret(password, 10);
    const businessId = user.businessId ?? null;

    let kept: KeptSessionTokens;

    try {
      kept = await setPasswordKeepingSession(this.user, {
        userId: user.id,
        passwordHash,
        family,
        client,
        effects: async (tx) => {
          if (!businessId) return;

          await this.outbox.publish(tx, {
            topic: "driver-access.password_created",
            aggregateType: "user",
            aggregateId: user.id,
            businessId,
            actorId: user.id,
            payload: {
              businessId,
              driverUserId: user.id,
              driverName: user.name,
              issuedById: enrollment?.createdById ?? null,
              at: now.toISOString(),
            },
          });
        },
      });
    } catch (error) {
      // The QR's session ended after the check above (the manager
      // disconnected the phone, a logout): nothing was written, and without
      // that session nothing allows a password with no current one.
      if (error instanceof KeptSessionEndedError) {
        throw new PasswordCreateNotAllowedError();
      }

      throw new AppError(
        "Não foi possível criar a sua senha, por favor tente novamente!",
        500,
      );
    }

    this.notificationService.createActivityIfEnabled({
      type: "Usuário",
      action: "update",
      entityId: user.id,
      description: `Senha criada pelo motorista ${user.name} depois do QR Code de acesso`,
      status: "Atualizado",
      performedBy: user.id,
      businessId,
    });

    // Somebody else creating it is what the mailbox owner must hear; never
    // awaited, never a 500 for a password already set. No mailbox, no notice.
    if (user.email) {
      void sendTransactionalMail({
        email: user.email,
        name: user.name,
        subject: "Sua senha foi atualizada com sucesso",
        templateName: "user-password-updated.hbs",
        moduleName: "user",
        additionalVariablesProperties: { logo: emailLogoUrl() },
      }).catch((error) =>
        log.error(
          { err: error, userId: user.id },
          "password creation notice could not be sent",
        ),
      );
    }

    return { ...kept, mustChangePassword: false };
  }
}

export {
  CLOCK_SKEW_MS,
  CREATE_AFTER_QR_WINDOW_MS,
  CreateOwnPasswordUseCase,
  isSessionOpenedByQr,
};
export type { CreatedOwnPassword };
