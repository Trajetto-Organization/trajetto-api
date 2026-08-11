import { inject, injectable } from "tsyringe";
import { IUserRepository } from "../../repositories/IUser-repository";

import { User } from "../../dtos/user-dto";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UploadService } from "@/shared/services/upload-service";

@injectable()
class GetUserUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(userId: string): Promise<User> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    return {
      ...findUser,
      avatar: findUser.avatar
        ? await this.uploadService.getFileUrl(findUser.avatar)
        : null,
    };
  }
}

export { GetUserUseCase };
