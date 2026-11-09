import { inject, injectable } from "tsyringe";

import { compareSecret, hashSecret } from "@/shared/security/bcrypt-gate";
import {
  IUserRepository,
  KeptSessionEndedError,
} from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserUpdateUserIsSamePasswordError } from "../errors/user-update-user-is-same-password-error";

import { UserUpdateUserPasswordNotMatchError } from "../errors/user-update-user-password-not-match-error";
import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";

import { AppError } from "@/shared/errors/AppError";
import { sendSecurityEventToUser } from "@/websocket";
import { logger } from "@/shared/logging/logger";
import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";
import {
  type KeptSessionTokens,
  setPasswordKeepingSession,
} from "../../services/password-session";
import type { HeaderSessionClient } from "../../services/session-service";

const log = logger.child({ component: "user" });

interface UpdateUserPasswordProps {
  currentPassword: string;
  newPassword: string;
  userId: string;

  /**
   * The caller's session (the access token's refresh family), kept and
   * re-issued (wave 2). Without it, or once it is no longer live, every
   * session ends, as before.
   */
  sessionId?: string;

  /** What the request's x-trajetto-client header asks for. */
  client?: HeaderSessionClient;
}

/**
 * The new pair of the session that changed the password; absent when no
 * session could be kept. `mustChangePassword` is false: the person chose it.
 */
type UpdatedUserPassword = Partial<KeptSessionTokens> & {
  mustChangePassword: false;
};

/**
 * PATCH /user/password: the person changes their own password with the
 * current one.
 *
 * It keeps the session it is called from (wave 2, 06/11/2026; owner's
 * decision): a driver changing the password mid-route was thrown out of the
 * app, because the change ended every session, the caller's included. Every
 * other session still ends; this one gets new tokens in the answer
 * (services/password-session). A client that ignores them behaves as before:
 * the version bump signs it out at its next request.
 */
@injectable()
class UpdateUserPasswordUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute({
    currentPassword,
    newPassword,
    userId,
    sessionId,
    client = "web",
  }: UpdateUserPasswordProps): Promise<UpdatedUserPassword> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const comparePassword = await compareSecret(
      currentPassword,
      findUser.password,
    );

    if (!comparePassword) {
      throw new UserUpdateUserPasswordNotMatchError();
    }

    const isSamePassword = await compareSecret(newPassword, findUser.password);

    if (isSamePassword) {
      throw new UserUpdateUserIsSamePasswordError();
    }

    const hashedPassword = await hashSecret(newPassword, 10);

    const family = sessionId
      ? await this.usersTokens.findSessionFamily(userId, sessionId)
      : null;

    let kept: KeptSessionTokens | null = null;

    try {
      if (family) {
        kept = await setPasswordKeepingSession(this.user, {
          userId,
          passwordHash: hashedPassword,
          family,
          client,
        }).catch((error: unknown) => {
          // It ended after the check above (nothing was written): the
          // password is changed as for a session no longer live.
          if (error instanceof KeptSessionEndedError) return null;

          throw error;
        });
      }

      if (!kept) {
        await this.user.updateUserPassword({
          userId,
          password: hashedPassword,
        });

        sendSecurityEventToUser(userId, { reason: "password_changed" });
      }
    } catch (error) {
      throw new AppError(
        "Não foi possível atualizar a sua senha, por favor tente novamente!",
        500,
      );
    }

    this.sendNotice(findUser);

    return { ...(kept ?? {}), mustChangePassword: false };
  }

  /**
   * The password is already changed: a mail failure must not answer 500, or
   * the person retries with a "current password" that no longer works. Nor
   * may the answer wait on the SMTP round trip (10 s timeouts) for a notice
   * the person does not need in order to carry on. A driver's login without
   * an e-mail (D2) gets no notice: there is no mailbox.
   */
  private sendNotice(user: { id: string; email: string | null; name: string }) {
    if (!user.email) return;

    void sendTransactionalMail({
      email: user.email,
      name: user.name,
      subject: "Sua senha foi atualizada com sucesso",
      templateName: "user-password-updated.hbs",
      moduleName: "user",
      additionalVariablesProperties: {
        logo: emailLogoUrl(),
      },
    }).catch((error) =>
      log.error(
        { err: error, userId: user.id },
        "password change notice could not be sent",
      ),
    );
  }
}

export { UpdateUserPasswordUseCase };
export type { UpdatedUserPassword };
