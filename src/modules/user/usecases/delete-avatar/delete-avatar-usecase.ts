import { inject, injectable } from "tsyringe";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { User } from "../../dtos/user-dto";

import { UploadService } from "@/shared/services/upload-service";

@injectable()
class DeleteAvatarUseCase {
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

    // If user has no avatar, return error
    if (!findUser.avatar) {
      throw new AppError("Usuário não possui avatar para ser deletado.", 400);
    }

    try {
      // Delete avatar file from storage
      await this.uploadService.deleteFile(findUser.avatar);

      // Update user avatar to null
      const updatedUser = await this.user.updateAvatar(userId, null);

      if (!updatedUser) {
        throw new AppError(
          "Houve um erro ao tentar deletar o avatar do usuário! Por favor, tente novamente.",
          500,
        );
      }

      return updatedUser;
    } catch (error) {
      // If it's an AppError (validation, business logic), rethrow it
      if (error instanceof AppError) {
        throw error;
      }

      // For unexpected errors, throw generic message
      throw new AppError(
        "Houve um erro ao tentar deletar o avatar! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteAvatarUseCase };
