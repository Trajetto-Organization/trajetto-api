import { inject, injectable } from "tsyringe";
import { hash } from "bcrypt";

import { IUserRepository } from "../../repositories/IUser-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";

import { UserAlreadyExistsError } from "../errors/user-already-exists.error";
import { BusinessNotFoundError } from "../../../business/usecases/errors/business-not-found-error";

import { UserDriverAlreadyLinkedToUserError } from "../errors/user-driver-already-linked-to-user-error";
import { UserCannotHaveBothDriverAndProfileError } from "../errors/user-cannot-have-both-driver-and-profile-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { NotificationService } from "@/shared/services/notification-service";

import { UserProfileAccessNotFoundError } from "../errors/user-profile-access-not-found-error";
import { ResourceNotFoundError } from "../errors/resource-not-found-error";

import { UpdateUser, User, UserRole } from "../../dtos/user-dto";
import { AppError } from "@/shared/errors/AppError";

import { UserCannotBeUpdatedByHimselfError } from "../errors/user-cannot-be-updated-by-himself-error";
import { UserProfileNotMatchBusinessError } from "../errors/user-profile-not-match-business-error";

import { UserMasterOnlyCanBeUpdatePasswordError } from "../errors/user-master-only-can-be-update-password-error";

import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { sendSecurityEventToUser } from "@/websocket";

import { env } from "@/env";
import { assertTenantAccessToRecord } from "@/modules/middlewares/tenant-authorization";

@injectable()
class UpdateUserUseCase {
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
  ) {}

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

    // Against the target's CURRENT tenant, before any of the checks below —
    // those validate against `targetBusinessId`, which comes from the body and
    // is therefore always the caller's own company.
    assertTenantAccessToRecord(findUser, userToUpdate.businessId);

    const isChangingToBusinessAdmin = userData.role === "BUSINESS_ADMIN";

    // Validate mutual exclusivity between profileAccessId and driverId
    if (userData.profileAccessId && userData.driverId) {
      throw new UserCannotHaveBothDriverAndProfileError();
    }

    // Determine the target business ID (new business if changing, otherwise current)
    const targetBusinessId = userData.businessId || userToUpdate.businessId;

    // If driverId is provided, validate driver
    if (userData.driverId) {
      const existingDriver = await this.driver.findDriverById(
        userData.driverId,
      );

      if (!existingDriver) {
        throw new DriverNotFoundError();
      }

      // Check if driver belongs to the same business as the user (current or new)
      if (existingDriver.businessId !== targetBusinessId) {
        throw new DriverNotBelongBusinessError();
      }

      // Check if driver is already linked to another user (excluding current user)
      const driverLinkedUser = await this.user.findUserByDriverId(
        userData.driverId,
      );

      if (driverLinkedUser && driverLinkedUser.id !== userId) {
        throw new UserDriverAlreadyLinkedToUserError();
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
          throw new UserProfileAccessNotFoundError();
        }

        // Validate against target business (new business if changing, otherwise current)
        if (existingProfileAccess.businessId !== targetBusinessId) {
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
      hashedPassword = await hash(userData.password, 10);
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

    // Sanitize data before sending to repository
    const cleanUserData = { ...userData };

    // Password: only send if provided (already hashed above)
    if (hashedPassword) {
      cleanUserData.password = hashedPassword;
    } else {
      delete cleanUserData.password;
    }

    // BUSINESS_ADMIN: must not have profileAccess or driver
    if (cleanUserData.role === "BUSINESS_ADMIN") {
      cleanUserData.profileAccessId = null;
      cleanUserData.driverId = null;
    }

    // Empty strings mean "disconnect" — normalize to null
    if (
      cleanUserData.profileAccessId !== undefined &&
      (cleanUserData.profileAccessId === "" ||
        cleanUserData.profileAccessId === null)
    ) {
      cleanUserData.profileAccessId = null;
    }

    if (
      cleanUserData.driverId !== undefined &&
      (cleanUserData.driverId === "" || cleanUserData.driverId === null)
    ) {
      cleanUserData.driverId = null;
    }

    try {
      const userUpdated = await this.user.updateUser({
        userData: cleanUserData,
        userId,
      });

      if (userData.email && userData.name) {
        await sendTransactionalMail({
          email: userData.email,
          name: userData.name,
          subject: "Conta atualizada com sucesso",
          templateName: "user-updated-successfully.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            logo: this.cloudinaryLogo,
          },
        });

        if (userData.password && userData.password !== findUser.password) {
          await sendTransactionalMail({
            email: userData.email,
            name: userData.name,
            subject: "Senha alterada com sucesso",
            templateName: "admin-user-updated-password.hbs",
            moduleName: "user",
            additionalVariablesProperties: {
              password: userData.password,
              logo: this.cloudinaryLogo,
            },
          });
        }
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

      const securityFieldsChanged =
        !!hashedPassword ||
        userData.role !== undefined ||
        userData.email !== undefined ||
        userData.businessId !== undefined ||
        userData.profileAccessId !== undefined ||
        userData.driverId !== undefined;

      if (securityFieldsChanged) {
        sendSecurityEventToUser(userId, { reason: "user_updated" });
      }

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
