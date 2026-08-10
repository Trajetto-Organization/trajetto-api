import { inject, injectable } from "tsyringe";

import { hash, compare } from "bcrypt";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserUpdateUserIsSamePasswordError } from "../errors/user-update-user-is-same-password-error";

import { UserUpdateUserPasswordNotMatchError } from "../errors/user-update-user-password-not-match-error";
import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";

import { AppError } from "@/shared/errors/AppError";
import { env } from "@/env";
import { sendSecurityEventToUser } from "@/websocket";

interface UpdateUserPasswordProps {
  currentPassword: string;
  newPassword: string;
  userId: string;
}

@injectable()
class UpdateUserPasswordUseCase {
  private emailQueue: EmailWorkerAdapter;
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {
    this.emailQueue = new EmailWorkerAdapter("updateUserPasswordQueue");
  }

  async execute({
    currentPassword,
    newPassword,
    userId,
  }: UpdateUserPasswordProps): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const comparePassword = await compare(currentPassword, findUser.password);

    if (!comparePassword) {
      throw new UserUpdateUserPasswordNotMatchError();
    }

    const isSamePassword = await compare(newPassword, findUser.password);

    if (isSamePassword) {
      throw new UserUpdateUserIsSamePasswordError();
    }

    const hashedPassword = await hash(newPassword, 10);

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

    await this.emailQueue.enqueueEmail({
      email: findUser.email,
      name: findUser.name,
      subject: "Sua senha foi atualizada com sucesso",
      templateName: "user-password-updated.hbs",
      moduleName: "user",
      additionalVariablesProperties: {
        logo: this.cloudinaryLogo,
      },
    });
  }
}

export { UpdateUserPasswordUseCase };
