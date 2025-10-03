import { hash } from "bcrypt";
import { inject, injectable } from "tsyringe";

import { v4 as uuidV4 } from "uuid";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { DriverAlreadyLinkedToUserError } from "../errors/driver-already-linked-to-user-error";
import { UserCannotHaveBothDriverAndProfileError } from "../errors/user-cannot-have-both-driver-and-profile-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { NotificationService } from "@/shared/services/notification-service";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { BusinessNotFoundError } from "../errors/business-not-found-error";
import { ProfileAccessNotFoundError } from "../errors/profile-access-not-found-error";

import { CreateUserProps, User, UserRole } from "../../dtos/user-dto";
import { AppError } from "@/shared/errors/AppError";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserProfileNotMatchBusinessError } from "../errors/user-profile-not-match-business-error";

import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";
import { env } from "@/env";

@injectable()
class CreateUserUseCase {
  private http_request = env.HTTP_REQUEST;
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  private emailQueue: EmailWorkerAdapter;

  private allowedRoles: Record<UserRole, UserRole[]> = {
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
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("DriverRepository")
    private driver: IDriverRepository,
  ) {
    this.emailQueue = new EmailWorkerAdapter("createUserEmailQueue");
  }

  // Generate a random password with letters, numbers and special characters
  private generateRandomPassword(): string {
    const chars =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let password = "";
    for (let i = 0; i < 12; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  async execute(
    {
      password,
      email,
      name,
      role,
      businessId,
      profileAccessId,
      driverId,
    }: CreateUserProps,
    id: string,
  ): Promise<User> {
    const findUser = await this.user.findUserById(id);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Only MASTER users can provide custom passwords
    if (password && findUser.role !== "MASTER") {
      throw new AppError(
        "Apenas usuários com nível de acesso Master podem definir senhas personalizadas. A senha será gerada automaticamente.",
        403,
      );
    }

    // Generate automatic password for non-MASTER users or when no password is provided
    const finalPassword = password || this.generateRandomPassword();

    if (!this.allowedRoles[findUser.role].includes(role)) {
      throw new AppError(
        `Usuários com o nível de acesso "${
          this.roleDisplayName[findUser.role]
        }" não podem criar usuários com o nível de acesso ${
          this.roleDisplayName[role]
        }.`,
        403,
      );
    }

    // Validate mutual exclusivity between profileAccessId and driverId
    if (profileAccessId && driverId) {
      throw new UserCannotHaveBothDriverAndProfileError();
    }

    // If driverId is provided, validate driver
    if (driverId) {
      const existingDriver = await this.driver.findDriverById(driverId);

      if (!existingDriver) {
        throw new DriverNotFoundError();
      }

      // Check if driver belongs to the same business
      if (existingDriver.businessId !== businessId) {
        throw new DriverNotBelongBusinessError();
      }

      // Check if driver is already linked to another user
      const driverLinkedUser = await this.user.findUserByDriverId(driverId);
      if (driverLinkedUser) {
        throw new DriverAlreadyLinkedToUserError();
      }
    }

    // If profileAccessId is provided (and not BUSINESS_ADMIN), validate profile
    if (role !== "BUSINESS_ADMIN" && profileAccessId) {
      const existingProfileAccess =
        await this.profileAccess.findProfileAccessById(
          profileAccessId as string,
        );

      if (!existingProfileAccess) {
        throw new ProfileAccessNotFoundError();
      }

      // Checks if the access profile belongs to the same company as the user
      if (existingProfileAccess.businessId !== businessId) {
        throw new UserProfileNotMatchBusinessError();
      }
    }

    const findBusinessByCorporateReason =
      await this.business.findBusinessById(businessId);

    if (!findBusinessByCorporateReason) {
      throw new BusinessNotFoundError();
    }

    const hashedPassword = await hash(finalPassword, 6);
    const userAlreadyExists = await this.user.findUserByEmail(email);

    if (userAlreadyExists) {
      throw new UserAlreadyExistsError();
    }

    const token = uuidV4();
    const expires = new Date(new Date().getTime() + 3600 * 1000); // 1 hour in milliseconds

    try {
      const userCreated = await this.user.createUser({
        email,
        password: hashedPassword,
        name,
        role,
        businessId,
        profileAccessId,
        driverId,
      });

      const verificationToken =
        await this.usersTokens.createEmailVerificationToken({
          email,
          token,
          expires,
        });

      await Promise.all([
        this.emailQueue.enqueueEmail({
          email,
          name,
          subject: "Verificação de e-mail",
          templateName: "email-verification.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            url: `${this.http_request}/new-verification?token=${verificationToken.token}`,
            logo: this.cloudinaryLogo,
          },
        }),
        this.emailQueue.enqueueEmail({
          email,
          name,
          subject: "Conta criada com sucesso",
          templateName: "user-created-successfully.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            email: email,
            password: finalPassword,
            logo: this.cloudinaryLogo,
          },
        }),
      ]);

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Usuário",
        action: "create",
        entityId: userCreated.id,
        description: `Usuário ${userCreated.name} criado | E-mail não verificado: ${userCreated.email}`,
        status: userCreated.email_verified ? "Ativo" : "Pendente",
        performedBy: id,
        businessId,
      });

      return userCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o usuário! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateUserUseCase };
