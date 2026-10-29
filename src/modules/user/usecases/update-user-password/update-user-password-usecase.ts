import { inject, injectable } from "tsyringe";

import { compareSecret, hashSecret } from "@/shared/security/bcrypt-gate";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserUpdateUserIsSamePasswordError } from "../errors/user-update-user-is-same-password-error";

import { UserUpdateUserPasswordNotMatchError } from "../errors/user-update-user-password-not-match-error";
import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";

import { AppError } from "@/shared/errors/AppError";
import { sendSecurityEventToUser } from "@/websocket";
import { logger } from "@/shared/logging/logger";
import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";

const log = logger.child({ component: "user" });

interface UpdateUserPasswordProps {
  currentPassword: string;
  newPassword: string;
  userId: string;
}

@injectable()
class UpdateUserPasswordUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({
    currentPassword,
    newPassword,
    userId,
  }: UpdateUserPasswordProps): Promise<void> {
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

    try {
      await this.user.updateUserPassword({
        userId,
        password: hashedPassword,
      });

      sendSecurityEventToUser(userId, { reason: "password_changed" });
    } catch (error) {
      throw new AppError(
        "Não foi possível atualizar a sua senha, por favor tente novamente!",
        500,
      );
    }

    // The password is already changed: a mail failure must not answer 500,
    // or the person retries with a "current password" that no longer works.
    // Nor may the answer wait on the SMTP round trip (10 s timeouts) for a
    // notice the person does not need in order to carry on.
    void sendTransactionalMail({
      email: findUser.email,
      name: findUser.name,
      subject: "Sua senha foi atualizada com sucesso",
      templateName: "user-password-updated.hbs",
      moduleName: "user",
      additionalVariablesProperties: {
        logo: emailLogoUrl(),
      },
    }).catch((error) =>
      log.error(
        { err: error, userId },
        "password change notice could not be sent",
      ),
    );
  }
}

export { UpdateUserPasswordUseCase };
