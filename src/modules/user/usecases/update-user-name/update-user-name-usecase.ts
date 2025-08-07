import { inject, injectable } from "tsyringe";
import { IUserRepository } from "../../repositories/IUser-repository";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { UserNameNotBeUpdatedError } from "../errors/user-name-not-be-updated-error";

interface UpdateUserNameProps {
  name: string;
  userId: string;
}

@injectable()
class UpdateUserNameUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({ name, userId }: UpdateUserNameProps): Promise<void> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (findUser.name.trim() === name.trim()) {
      throw new UserNameNotBeUpdatedError();
    }

    try {
      await this.user.updateUserName({
        userId,
        name,
      });
    } catch (error) {
      throw new AppError(
        "Não foi possível atualizar o seu nome de usuário! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateUserNameUseCase };
