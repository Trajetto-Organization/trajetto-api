import { inject, injectable } from "tsyringe";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { User } from "../../dtos/user-dto";

import { UploadService } from "@/shared/services/upload-service";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "user" });

@injectable()
class UploadAvatarUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UploadService")
    private uploadService: UploadService,
  ) {}

  async execute(
    userId: string,

    // The avatar the client uploaded straight to storage. Scoped by user, not
    // by business: an avatar belongs to a person, and a MASTER user may have
    // no business at all.
    presignedPhoto: { key: string },
  ): Promise<User> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    let newAvatarPath: string | null = null;
    const oldAvatarPath = findUser.avatar;

    try {
      // Step 1: Resolve the new avatar first, before touching the database or
      // deleting the old file.
      const [resolved] = await this.uploadService.resolvePresignedUploads(
        [presignedPhoto],
        "avatars",
        userId,
      );

      newAvatarPath = resolved.path;

      // Step 2: Try to update user avatar path in database
      const updatedUser = await this.user.updateAvatar(userId, newAvatarPath);

      if (!updatedUser) {
        // The catch below removes the new file, once.
        throw new AppError(
          "Houve um erro ao tentar atualizar o avatar do usuário! Por favor, tente novamente.",
          500,
        );
      }

      // The row now points at the new file: from here on it is the avatar,
      // never an orphan to clean up, and the change has happened — nothing
      // that fails next may answer it as a failure.
      newAvatarPath = null;

      // Step 3: Only delete old avatar after successful database update.
      // A leftover old file is the orphan sweep's (UPLOAD_ORPHAN_GC).
      if (oldAvatarPath) {
        await this.uploadService
          .deleteFile(oldAvatarPath)
          .catch((err: unknown) => {
            log.error(
              { err, key: oldAvatarPath, userId },
              "previous avatar could not be deleted",
            );
          });
      }

      return {
        ...updatedUser,
        avatar: updatedUser.avatar
          ? await this.signedAvatarUrl(updatedUser.avatar, userId)
          : null,
      };
    } catch (error) {
      // If upload succeeded but something failed after, clean up the new file
      if (newAvatarPath) {
        try {
          await this.uploadService.deleteFile(newAvatarPath);
        } catch (cleanupError) {
          // Log cleanup error but don't throw to preserve original error
          log.error(
            { err: cleanupError, key: newAvatarPath, userId },
            "uploaded avatar could not be cleaned up",
          );
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

  /** The URL to show now, or null: the next /user/me signs it again. */
  private async signedAvatarUrl(
    path: string,
    userId: string,
  ): Promise<string | null> {
    try {
      return await this.uploadService.getFileUrl(path);
    } catch (err) {
      log.error(
        { err, key: path, userId },
        "new avatar URL could not be signed",
      );

      return null;
    }
  }
}

export { UploadAvatarUseCase };
