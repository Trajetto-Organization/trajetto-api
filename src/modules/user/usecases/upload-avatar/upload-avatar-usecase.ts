import { inject, injectable } from "tsyringe";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { User } from "../../dtos/user-dto";

import { UploadService } from "@/shared/services/upload-service";
import { MultipartFile } from "@fastify/multipart";

@injectable()
class UploadAvatarUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(userId: string, avatarFile: MultipartFile): Promise<User> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    try {
      // If user already has an avatar, delete the old one
      if (findUser.avatar) {
        await this.uploadService.deleteFile(findUser.avatar);
      }

      // Upload new avatar photo
      const buffer = await avatarFile.toBuffer();
      const uploadResult = await this.uploadService.uploadFile({
        buffer,
        filename: avatarFile.filename || "avatar",
        mimetype: avatarFile.mimetype,
        uploadType: "avatars",
      });

      // Update user avatar path
      const updatedUser = await this.user.updateAvatar(
        userId,
        uploadResult.path,
      );

      if (!updatedUser) {
        throw new AppError(
          "Houve um erro ao tentar atualizar o avatar do usuário! Por favor, tente novamente.",
          500,
        );
      }

      return {
        ...updatedUser,
        avatar: updatedUser.avatar
          ? this.uploadService.getFileUrl(updatedUser.avatar)
          : null,
      };
    } catch (error) {
      // If it's an AppError (validation, business logic), rethrow it
      if (error instanceof AppError) {
        throw error;
      }

      // For unexpected errors, throw generic message
      throw new AppError(
        "Houve um erro ao tentar fazer upload do avatar! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UploadAvatarUseCase };
