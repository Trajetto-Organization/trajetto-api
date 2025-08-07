import { inject, injectable } from "tsyringe";
import { IUserRepository } from "../../repositories/IUser-repository";

import { User } from "../../dtos/user-dto";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

@injectable()
class GetUserUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute(userId: string): Promise<User> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    return findUser;
  }
}

export { GetUserUseCase };
