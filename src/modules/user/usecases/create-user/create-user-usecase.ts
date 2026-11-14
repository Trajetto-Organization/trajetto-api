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
import { conflictFromPrisma } from "@/shared/errors/prisma-conflict";
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
import {
  DRIVER_ONLY_PASSWORD_MESSAGE,
  isDriverLogin,
} from "@/schemas/create-user-schema";

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
    managerSetPassword: boolean,
  ): Promise<void> {
    try {
      // A driver's login without an e-mail (decision D02, plan of
      // 02/11/2026) has no mailbox to send the link to: it signs in by QR
      // code or by the password the manager set. Neither does one whose
      // password the manager set (D2): there is nothing left to set or
      // confirm, and a second e-mail is what kept drivers from signing in.
      const mailbox = userCreated.email;

      if (mailbox && !managerSetPassword) {
        await this.sendCredentialEmails(userCreated, mailbox);
      }

      // Who set the password is the activity's author (decision D04: the
      // manager knows it, so it is on record). The password itself never
      // goes in.
      const detail = managerSetPassword
        ? "Senha inicial definida pelo gestor"
        : mailbox
          ? `E-mail não verificado: ${mailbox}`
          : "Sem e-mail";

      this.notificationService.createActivityIfEnabled({
        type: "Usuário",
        action: "create",
        entityId: userCreated.id,
        description: `Usuário ${userCreated.name} criado | ${detail}`,
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

  private async sendCredentialEmails(
    userCreated: User,
    mailbox: string,
  ): Promise<void> {
    const token = uuidV4();
    const expires = new Date(new Date().getTime() + 3600 * 1000); // 1 hour

    // The link carries the local token: the row only holds its hash.
    await this.usersTokens.createEmailVerificationToken({
      email: mailbox,
      token,
      expires,
    });

    const setupUrl = await issuePasswordSetupLink(
      this.usersTokens,
      mailbox,
      NEW_ACCOUNT_LINK_TTL_MS,
    );

    await Promise.all([
      sendTransactionalMail({
        email: mailbox,
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
        email: mailbox,
        name: userCreated.name,
        subject: "Conta criada com sucesso",
        templateName: "user-created-successfully.hbs",
        moduleName: "user",
        additionalVariablesProperties: {
          email: mailbox,
          url: setupUrl,
          logo: emailLogoUrl(),
        },
      }),
    ]);
  }

  async execute(
    {
      email,
      name,
      role,
      businessId,
      profileAccessId,
      driverId,
      password,
    }: CreateUserProps,
    id: string,
  ): Promise<User> {
    // Only a driver's login takes a password from the manager (D2; decision
    // D04). The schema refuses it first; this holds for any other caller.
    if (password !== undefined && !isDriverLogin({ role, driverId })) {
      throw new AppError(
        DRIVER_ONLY_PASSWORD_MESSAGE,
        400,
        "USER_PASSWORD_DRIVER_ONLY",
      );
    }

    // Only a driver's login may have no e-mail (decision D02): it signs in by
    // CPF and password or by QR code. Same rule as the schema's.
    const mailbox = email ?? null;

    if (mailbox === null && !isDriverLogin({ role, driverId })) {
      throw new AppError("O e-mail é obrigatório.", 400, "USER_EMAIL_REQUIRED");
    }

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

    // Nobody knows it: the person sets theirs through the e-mailed link —
    // unless the manager set a driver's (D2).
    const managerSetPassword = password !== undefined;
    const hashedPassword = await hashSecret(
      managerSetPassword ? password : unusablePassword(),
      10,
    );
    // No address, nothing to collide with: the unique index lets many NULLs
    // coexist.
    if (mailbox !== null && (await this.user.findUserByEmail(mailbox))) {
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
        email: mailbox,
        password: hashedPassword,
        name,
        role,
        businessId,
        profileAccessId: cleanProfileAccessId,
        driverId: cleanDriverId,
        // No e-mail goes out to confirm it, so the address the manager typed
        // stands as confirmed (D2): the driver signs in at once. Without an
        // address there is nothing to confirm.
        email_verified: managerSetPassword && mailbox ? new Date() : null,
        // The manager knows it (wave 2): the driver creates their own at the
        // first sign-in.
        must_change_password: managerSetPassword,
      });

      // A driver now has an app login: the chat pickers' "com o app" split
      // changes for the company's open tabs.
      if (cleanDriverId) announceDriverLoginChange(businessId);

      // Process notifications asynchronously without blocking the main flow
      void this.processNotifications(
        userCreated,
        id,
        businessId,
        managerSetPassword,
      );

      return userCreated;
    } catch (error) {
      // Two requests with the same e-mail, or for the same driver, both
      // passed the lookups above: the loser meets the index and hears the
      // same 409 the lookup would have given, never a 500.
      throw (
        (await conflictFromPrisma(error, {
          unique: {
            email: () => new UserAlreadyExistsError(),
            driverId: () => new UserDriverAlreadyLinkedToUserError(),
          },
        })) ??
        new AppError(
          "Houve um erro ao tentar criar o usuário! Por favor, tente novamente.",
          500,
        )
      );
    }
  }
}

export { CreateUserUseCase };
