import { inject, injectable } from "tsyringe";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { UserRole } from "../../dtos/user-dto";
import { UserCannotBeRevokeByHimselfError } from "../errors/user-cannot-be-revoke-access-by-himself-error";

interface UserRevokeAccessProps {
  userId: string;
  id: string;
}

@injectable()
class UserRevokeAccessUseCase {
  private allowedDeletion: Record<UserRole, UserRole[]> = {
    BUSINESS_USER: ["BUSINESS_USER"],
    BUSINESS_ADMIN: ["BUSINESS_USER", "BUSINESS_ADMIN"],
    MASTER: ["BUSINESS_USER", "BUSINESS_ADMIN", "MASTER"],
  };

  private roleDisplayName: Record<UserRole, string> = {
    BUSINESS_USER: "Usuário",
    BUSINESS_ADMIN: "Administrador",
    MASTER: "Master",
  };

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({ userId, id }: UserRevokeAccessProps): Promise<void> {
    const findUser = await this.user.findUserById(id);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (findUser.id === userId) {
      throw new UserCannotBeRevokeByHimselfError();
    }

    const findRevokedUser = await this.user.findUserById(userId);

    if (!findRevokedUser) {
      throw new ResourceNotFoundError();
    }

    if (!this.allowedDeletion[findUser.role].includes(findRevokedUser.role)) {
      throw new AppError(
        `Usuários com o nível de acesso "${
          this.roleDisplayName[findUser.role]
        }" não podem deletar usuários com o nível de acesso ${
          this.roleDisplayName[findRevokedUser.role]
        }.`,
        403,
      );
    }

    try {
      if (findRevokedUser.access_revoked) {
        await this.user.updateUserAccessRevocation({
          userId,
          isAccessRevoke: false,
        });

        return;
      }

      await this.user.updateUserAccessRevocation({
        userId,
        isAccessRevoke: true,
      });
    } catch (error) {
      throw new AppError(
        "Não foi possível revogar o acesso deste usuário! Por favor, Tente novamente.",
        500,
      );
    }
  }
}

export { UserRevokeAccessUseCase };
