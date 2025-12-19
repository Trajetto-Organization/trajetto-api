import { inject, injectable } from "tsyringe";
import { hash } from "bcrypt";

import { IUserRepository } from "../../repositories/IUser-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";

import { UserAlreadyExistsError } from "../errors/user-already-exists.error";
import { BusinessNotFoundError } from "../errors/business-not-found-error";

import { DriverAlreadyLinkedToUserError } from "../errors/driver-already-linked-to-user-error";
import { UserCannotHaveBothDriverAndProfileError } from "../errors/user-cannot-have-both-driver-and-profile-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { NotificationService } from "@/shared/services/notification-service";

import { ProfileAccessNotFoundError } from "../errors/profile-access-not-found-error";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UpdateUser, User, UserRole } from "../../dtos/user-dto";
import { AppError } from "@/shared/errors/AppError";

import { UserCannotBeUpdatedByHimselfError } from "../errors/user-cannot-be-updated-by-himself-error";
import { UserProfileNotMatchBusinessError } from "../errors/user-profile-not-match-business-error";

import { UserMasterOnlyCanBeUpdatePasswordError } from "../errors/user-master-only-can-be-update-password-error";

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
    @inject("DriverRepository")
    private driver: IDriverRepository,
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

    // Validate mutual exclusivity between profileAccessId and driverId
    if (userData.profileAccessId && userData.driverId) {
      throw new UserCannotHaveBothDriverAndProfileError();
    }

    // If driverId is provided, validate driver
    if (userData.driverId) {
      const existingDriver = await this.driver.findDriverById(
        userData.driverId,
      );

      if (!existingDriver) {
        throw new DriverNotFoundError();
      }

      // Check if driver belongs to the same business as the user
      if (existingDriver.businessId !== userToUpdate.businessId) {
        throw new DriverNotBelongBusinessError();
      }

      // Check if driver is already linked to another user (excluding current user)
      const driverLinkedUser = await this.user.findUserByDriverId(
        userData.driverId,
      );
      if (driverLinkedUser && driverLinkedUser.id !== userId) {
        throw new DriverAlreadyLinkedToUserError();
      }
    }

    // If profileAccessId is provided (and not changing to BUSINESS_ADMIN), validate profile
    if (!isChangingToBusinessAdmin && userToUpdate.role !== "BUSINESS_ADMIN") {
      // Only validate profileAccessId if it's provided and driverId is not provided
      if (userData.profileAccessId && !userData.driverId) {
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
      throw new UserMasterOnlyCanBeUpdatePasswordError();
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
      console.log("erro ao atualizar o usuário", error);
      throw new AppError(
        "Houve um erro ao tentar atualizar o usuário! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateUserUseCase };
