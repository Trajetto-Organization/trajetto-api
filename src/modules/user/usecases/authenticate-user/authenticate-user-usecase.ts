import { inject, injectable } from "tsyringe";

import crypto from "node:crypto";

import { compareSecret } from "@/shared/security/bcrypt-gate";

import { v4 as uuidV4 } from "uuid";

import {
  AuthenticateUserProps,
  EmailVerificationProps,
  TwoFactorProps,
} from "./dtos/authenticate-user-dto";

import { AuthenticateUser } from "../../dtos/user-dto";
import { authenticateUserSchema } from "@/schemas/authenticate-user-schema";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { UserInvalidCredentialsError } from "../errors/user-invalid-credentials-error";

import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { AppError } from "@/shared/errors/AppError";

import { env } from "@/env";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { assertSessionEligible } from "../../services/session-eligibility";
import {
  SessionClient,
  createUserSession,
} from "../../services/session-service";
import { isLoginLocked } from "@/shared/security/login-lockout-rules";
import { hashOneTimeCode } from "@/shared/security/one-time-code";
import { issueTwoFactorChallenge } from "../../services/two-factor-challenge";

/**
 * What an unknown e-mail's password is compared against.
 *
 * A cost-10 bcrypt of random bytes nobody kept — the same cost as every real
 * password (create-user, reset, update all hash at 10), so the compare takes
 * as long. Its preimage is irrelevant: the result is thrown away and the
 * refusal follows regardless. If the password cost ever changes, change this
 * with it, or the clock starts talking again.
 */
const DUMMY_PASSWORD_HASH =
  "$2b$10$wAKcV1HU9K3BzIyPKcPAJezSXVuGNshM5pUf0ZUoFwSsAKvj3Ofn6";

@injectable()
class AuthenticateUserUseCase {
  private http_request = env.HTTP_REQUEST;
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
  ) {}

  private async emailVerification({ email, name }: EmailVerificationProps) {
    const findExistingToken =
      await this.usersTokens.findEmailVerificationTokenByEmail(email);

    if (findExistingToken) {
      await this.usersTokens.deleteEmailVerificationToken(findExistingToken.id);
    }

    const tokenVerification = uuidV4();
    const expires = new Date(new Date().getTime() + 3600 * 1000); // 1 hour in milliseconds

    try {
      // The link carries the local token: the row only holds its hash.
      await this.usersTokens.createEmailVerificationToken({
        email: email,
        token: tokenVerification,
        expires,
      });

      await sendTransactionalMail({
        email,
        name,
        subject: "Verificação de e-mail",
        templateName: "email-verification.hbs",
        moduleName: "user",
        additionalVariablesProperties: {
          url: `${this.http_request}/new-verification?token=${tokenVerification}`,
          logo: this.cloudinaryLogo,
        },
      });

      return {
        emailVerificationMessage:
          "Um token de verificação foi enviado para este e-mail!",
        emailVerification: true,
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar enviar o código de verificação! Por favor, tente novamente.",
        500,
      );
    }
  }

  private async twoFactor({
    userId,
    email,
    name,
    sessionVersion,
  }: TwoFactorProps) {
    const existingTwoFactorTokenByEmail =
      await this.usersTokens.findTwoFactorTokenByEmail(email);

    if (existingTwoFactorTokenByEmail) {
      await this.usersTokens.deleteTwoFactorToken(
        existingTwoFactorTokenByEmail.id,
      );
    }

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();
    const hashedTwoFactorToken = hashOneTimeCode(twoFactorToken);

    const twoFactorExpires = new Date(new Date().getTime() + 15 * 60 * 1000); // 15 minutes in milliseconds

    const twoFactorConfirmation =
      await this.usersTokens.findTwoFactorConfirmationByUserId(userId);

    if (twoFactorConfirmation) {
      await this.usersTokens.deleteTwoFactorConfirmation(
        twoFactorConfirmation.id,
      );
    }

    try {
      await this.usersTokens.createTwoFactorToken({
        email: email,
        token: hashedTwoFactorToken,
        expires: twoFactorExpires,
      });

      await sendTransactionalMail({
        email,
        name,
        subject: "Código de verificação de dois fatores",
        templateName: "two-factor-verification-code.hbs",
        moduleName: "user",
        additionalVariablesProperties: {
          token: twoFactorToken,
          logo: this.cloudinaryLogo,
        },
      });

      return {
        twoFactorVerificationMessage:
          "Um código de verificação foi enviado para este e-mail!",
        isTwoFactorVerification: true,
        // The proof that the password was right, for the code step (WEB-07).
        twoFactorChallenge: issueTwoFactorChallenge({
          id: userId,
          email,
          session_version: sessionVersion,
        }),
      };
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar enviar o código de verificação! Por favor, tente novamente.",
        500,
      );
    }
  }

  async execute(
    authenticateUser: AuthenticateUser,
    client: SessionClient = "web",
  ): Promise<AuthenticateUserProps> {
    const { email, password } = authenticateUserSchema.parse(authenticateUser);
    const findUser = await this.user.findUserByEmail(email);

    if (!findUser) {
      // Same work as a wrong password before the same refusal: without it an
      // unknown e-mail answered ~50 ms sooner, and the clock told anybody
      // which addresses have an account (GAP3-11). The result is ignored.
      await compareSecret(password, DUMMY_PASSWORD_HASH);

      throw new UserInvalidCredentialsError("unknown_email");
    }

    const doesPasswordMatches = await compareSecret(
      password,
      findUser.password,
    );

    // The per-account brake (shared/security/login-lockout-rules). The route
    // limit lives in Redis and fails open; this one does not. Checked after
    // the comparison on purpose, so a locked account takes as long to refuse
    // as a wrong password, and refused with the same sentence: anything else
    // would tell whoever sent ten guesses that the address has an account.
    const now = new Date();

    if (isLoginLocked(findUser, now)) {
      throw new UserInvalidCredentialsError("account_locked", findUser.id);
    }

    if (!doesPasswordMatches) {
      await this.user.registerFailedLogin(findUser.id, now);

      throw new UserInvalidCredentialsError("wrong_password", findUser.id);
    }

    // A burst of guesses may have locked the account while this password was
    // being compared; the lock wins over a right guess in the same burst.
    if (!(await this.user.clearFailedLogins(findUser.id, now))) {
      throw new UserInvalidCredentialsError("account_locked", findUser.id);
    }

    await assertSessionEligible(findUser, this.driver);

    /**
     * Each flow pays for its own tokens, and only when it runs.
     *
     * The verification-token lookup, the two-factor lookup and delete, and a
     * cost-10 bcrypt of a fresh code all used to run on EVERY successful
     * login, before anything asked whether the account needed them. Nearly
     * every account is verified with two-factor off, so a login burst spent
     * half its bcrypt time hashing codes nobody would ever receive.
     */
    if (!findUser.email_verified) {
      return await this.emailVerification({
        email: findUser.email,
        name: findUser.name,
      });
    }

    if (findUser.two_factor_enabled) {
      return await this.twoFactor({
        email: findUser.email,
        name: findUser.name,
        userId: findUser.id,
        sessionVersion: findUser.session_version,
      });
    }

    const session = await createUserSession(
      findUser,
      this.usersTokens,
      client,
    );

    return { ...session, role: findUser.role };
  }
}

export { AuthenticateUserUseCase };
