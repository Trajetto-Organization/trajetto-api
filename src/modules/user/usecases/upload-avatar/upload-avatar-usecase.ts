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

    let newAvatarPath: string | null = null;
    const oldAvatarPath = findUser.avatar;

    try {
      // Step 1: Upload new avatar photo first (before touching database or deleting old file)
      const buffer = await avatarFile.toBuffer();
      const uploadResult = await this.uploadService.uploadFile({
        buffer,
        filename: avatarFile.filename || "avatar",
        mimetype: avatarFile.mimetype,
        uploadType: "avatars",
      });

      newAvatarPath = uploadResult.path;

      // Step 2: Try to update user avatar path in database
      const updatedUser = await this.user.updateAvatar(userId, newAvatarPath);

      if (!updatedUser) {
        // Rollback: Delete the newly uploaded file since database update failed
        await this.uploadService.deleteFile(newAvatarPath);

        throw new AppError(
          "Houve um erro ao tentar atualizar o avatar do usuário! Por favor, tente novamente.",
          500,
        );
      }

      // Step 3: Only delete old avatar after successful database update
      if (oldAvatarPath) {
        await this.uploadService.deleteFile(oldAvatarPath);
      }

      return {
        ...updatedUser,
        avatar: updatedUser.avatar
          ? this.uploadService.getFileUrl(updatedUser.avatar)
          : null,
      };
    } catch (error) {
      // If upload succeeded but something failed after, clean up the new file
      if (newAvatarPath) {
        try {
          await this.uploadService.deleteFile(newAvatarPath);
        } catch (cleanupError) {
          // Log cleanup error but don't throw to preserve original error
          console.error("Failed to cleanup uploaded file:", cleanupError);
        }
      }

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
