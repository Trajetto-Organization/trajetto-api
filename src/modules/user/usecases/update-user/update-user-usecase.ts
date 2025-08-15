import { inject, injectable } from "tsyringe";
import { hash } from "bcrypt";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";

import { UserAlreadyExistsError } from "../errors/user-already-exists.error";
import { BusinessNotFoundError } from "../errors/business-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { ProfileAccessNotFoundError } from "../errors/profile-access-not-found-error";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UpdateUser, User, UserRole } from "../../dtos/user-dto";
import { AppError } from "@/shared/errors/AppError";

import { UserCannotBeUpdatedByHimselfError } from "../errors/user-cannot-be-updated-by-himself-error";
import { UserProfileNotMatchBusinessError } from "../errors/user-profile-not-match-business-error";

import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";
import { env } from "@/env";

@injectable()
class UpdateUserUseCase {
  private emailQueue: EmailWorkerAdapter;
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  private allowedUpdate: Record<UserRole, UserRole[]> = {
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
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ProfileAccessRepository")
    private profileAccess: IProfileAccessRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {
    this.emailQueue = new EmailWorkerAdapter("updateUserEmailQueue");
  }

  async execute({ userId, userData }: UpdateUser, id: string): Promise<User> {
    const findUser = await this.user.findUserById(id);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (findUser.id === userId) {
      throw new UserCannotBeUpdatedByHimselfError();
    }

    const userToUpdate = await this.user.findUserById(userId);

    if (!userToUpdate) {
      throw new ResourceNotFoundError();
    }

    const isChangingToBusinessAdmin = userData.role === "BUSINESS_ADMIN";

    if (!isChangingToBusinessAdmin && userToUpdate.role !== "BUSINESS_ADMIN") {
      const existingProfileAccess =
        await this.profileAccess.findProfileAccessById(
          userData.profileAccessId,
        );

      if (!existingProfileAccess) {
        throw new ProfileAccessNotFoundError();
      }

      if (existingProfileAccess.businessId !== userToUpdate.businessId) {
        throw new UserProfileNotMatchBusinessError();
      }
    }

    if (userData.businessId) {
      const findBusinessById = await this.business.findBusinessById(
        userData.businessId,
      );

      if (!findBusinessById) {
        throw new BusinessNotFoundError();
      }
    }

    // Only MASTER users can update passwords
    if (userData.password && findUser.role !== "MASTER") {
      throw new AppError(
        "Apenas usuários com nível de acesso Master podem alterar senhas de outros usuários.",
        403,
      );
    }

    let hashedPassword: string | undefined;
    if (userData.password) {
      hashedPassword = await hash(userData.password, 6);
    }

    const newRole: UserRole = userData.role ? userData.role : userToUpdate.role;

    if (!this.allowedUpdate[findUser.role].includes(newRole)) {
      throw new AppError(
        `Usuários com o nível de acesso "${
          this.roleDisplayName[findUser.role]
        }" não podem atualizar usuários com o nível de acesso ${
          this.roleDisplayName[newRole]
        }.`,
        403,
      );
    }

    if (userData.email) {
      const userAlreadyExists = await this.user.findUserByEmail(userData.email);

      if (userAlreadyExists && userAlreadyExists.id !== userToUpdate.id) {
        throw new UserAlreadyExistsError();
      }
    }

    try {
      const userUpdated = await this.user.updateUser({
        userData: {
          ...userData,
          ...(hashedPassword && { password: hashedPassword }),
        },
        userId,
      });

      if (userData.email && userData.name) {
        await this.emailQueue.enqueueEmail({
          email: userData.email,
          name: userData.name,
          subject: "Conta atualizada com sucesso",
          templateName: "user-updated-successfully.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            logo: this.cloudinaryLogo,
          },
        });
      }

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Usuário",
        action: "update",
        entityId: userUpdated.id,
        description: `Usuário ${userUpdated.name} | ID: ${userUpdated.id} atualizado`,
        status: "Atualizado",
        performedBy: id,
        businessId: userData.businessId,
      });

      return userUpdated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o usuário! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateUserUseCase };
