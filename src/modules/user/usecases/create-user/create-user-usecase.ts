import { hashSecret } from "@/shared/security/bcrypt-gate";
import { inject, injectable } from "tsyringe";

import { v4 as uuidV4 } from "uuid";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IProfileAccessRepository } from "@/modules/profile-access/repositories/IProfile-access-repository";
import { UserAlreadyExistsError } from "../errors/user-already-exists.error";

import { UserDriverAlreadyLinkedToUserError } from "../errors/user-driver-already-linked-to-user-error";
import { UserCannotHaveBothDriverAndProfileError } from "../errors/user-cannot-have-both-driver-and-profile-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { NotificationService } from "@/shared/services/notification-service";

import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { UserProfileAccessNotFoundError } from "../errors/user-profile-access-not-found-error";

import { AppError } from "@/shared/errors/AppError";
import { permissionDenied } from "@/shared/errors/access-errors";
import { CreateUserProps, User, UserRole } from "../../dtos/user-dto";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserProfileNotMatchBusinessError } from "../errors/user-profile-not-match-business-error";

import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { logger } from "@/shared/logging/logger";

import { env } from "@/env";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { announceDriverLoginChange } from "../../services/driver-login-catalog";
import {
  NEW_ACCOUNT_LINK_TTL_MS,
  issuePasswordSetupLink,
  unusablePassword,
} from "../../services/password-setup-link";
import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";

const log = logger.child({ component: "user" });

@injectable()
class CreateUserUseCase {
  private http_request = env.HTTP_REQUEST;

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
  ) {}

  /**
   * The welcome e-mail carries a link to set the password, never the password
   * (decision 4.9): it used to mail a generated one in clear text, readable by
   * anyone with access to the mailbox or to the provider's logs.
   */
  private async processNotifications(
    userCreated: User,
    performedById: string,
    businessId: string,
  ): Promise<void> {
    try {
      const token = uuidV4();
      const expires = new Date(new Date().getTime() + 3600 * 1000); // 1 hour

      // The link carries the local token: the row only holds its hash.
      await this.usersTokens.createEmailVerificationToken({
        email: userCreated.email,
        token,
        expires,
      });

      const setupUrl = await issuePasswordSetupLink(
        this.usersTokens,
        userCreated.email,
        NEW_ACCOUNT_LINK_TTL_MS,
      );

      await Promise.all([
        sendTransactionalMail({
          email: userCreated.email,
          name: userCreated.name,
          subject: "Verificação de e-mail",
          templateName: "email-verification.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            url: `${this.http_request}/new-verification?token=${token}`,
            logo: emailLogoUrl(),
          },
        }),
        sendTransactionalMail({
          email: userCreated.email,
          name: userCreated.name,
          subject: "Conta criada com sucesso",
          templateName: "user-created-successfully.hbs",
          moduleName: "user",
          additionalVariablesProperties: {
            email: userCreated.email,
            url: setupUrl,
            logo: emailLogoUrl(),
          },
        }),
      ]);

      this.notificationService.createActivityIfEnabled({
        type: "Usuário",
        action: "create",
        entityId: userCreated.id,
        description: `Usuário ${userCreated.name} criado | E-mail não verificado: ${userCreated.email}`,
        status: userCreated.email_verified ? "Ativo" : "Pendente",
        performedBy: performedById,
        businessId,
      });
    } catch (error) {
      log.error(
        { err: error, userId: userCreated.id, businessId },
        "new user e-mails and activity could not be processed",
      );
    }
  }

  async execute(
    {
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

    // The company the new account joins must be the creator's own. The request
    // hook already refuses a foreign businessId, but this is the one write in
    // the product whose failure hands a stranger an administrator account in
    // somebody else's company, so it does not depend on a hook alone.
    assertTenantAccess(findUser, businessId);

    if (!this.allowedRoles[findUser.role].includes(role)) {
      // The same refusal as a missing permission (decision 4.1).
      throw permissionDenied(
        `Usuários com o nível de acesso "${
          this.roleDisplayName[findUser.role]
        }" não podem criar usuários com o nível de acesso ${
          this.roleDisplayName[role]
        }.`,
      );
    }

    // Validate mutual exclusivity between profileAccessId and driverId
    if (profileAccessId && driverId) {
      throw new UserCannotHaveBothDriverAndProfileError();
    }

    // Validate business exists FIRST before checking relationships
    const findBusinessByCorporateReason =
      await this.business.findBusinessById(businessId);

    if (!findBusinessByCorporateReason) {
      throw new BusinessNotFoundError();
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
        throw new UserDriverAlreadyLinkedToUserError();
      }
    }

    // If profileAccessId is provided (and not BUSINESS_ADMIN), validate profile
    if (role !== "BUSINESS_ADMIN" && profileAccessId) {
      const existingProfileAccess =
        await this.profileAccess.findProfileAccessById(
          profileAccessId as string,
        );

      if (!existingProfileAccess) {
        throw new UserProfileAccessNotFoundError();
      }

      // Checks if the access profile belongs to the same company as the user
      if (existingProfileAccess.businessId !== businessId) {
        throw new UserProfileNotMatchBusinessError();
      }
    }

    // Nobody knows it: the person sets theirs through the e-mailed link.
    const hashedPassword = await hashSecret(unusablePassword(), 10);
    const userAlreadyExists = await this.user.findUserByEmail(email);

    if (userAlreadyExists) {
      throw new UserAlreadyExistsError();
    }

    // Sanitize: BUSINESS_ADMIN has no profileAccess; empty strings become undefined/null
    const cleanProfileAccessId =
      role === "BUSINESS_ADMIN" ||
      !profileAccessId ||
      profileAccessId.trim() === ""
        ? undefined
        : profileAccessId;

    const cleanDriverId =
      !driverId || (typeof driverId === "string" && driverId.trim() === "")
        ? null
        : driverId;

    try {
      const userCreated = await this.user.createUser({
        email,
        password: hashedPassword,
        name,
        role,
        businessId,
        profileAccessId: cleanProfileAccessId,
        driverId: cleanDriverId,
      });

      // A driver now has an app login: the chat pickers' "com o app" split
      // changes for the company's open tabs.
      if (cleanDriverId) announceDriverLoginChange(businessId);

      // Process notifications asynchronously without blocking the main flow
      void this.processNotifications(userCreated, id, businessId);

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
