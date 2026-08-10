import { inject, injectable } from "tsyringe";

import { compare } from "bcrypt";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { UserInvalidTwoFactorCodeError } from "../errors/user-invalid-two-factor-code-error";
import { UserExpiredCodeError } from "../errors/user-expired-code-error";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserInvalidCodeForUserError } from "../errors/user-invalid-code-for-user-error";

import { AppError } from "@/shared/errors/AppError";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { assertSessionEligible } from "../../services/session-eligibility";
import { createUserSession } from "../../services/session-service";

interface TwoFactorVerificationQueryProps {
  twoFactorCode: string;
  email: string;
}

interface TwoFactorVerificationProps {
  token: string;
  refresh_token: string;
  role?: string;
}

@injectable()
class TwoFactorVerificationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
  ) {}

  async execute({
    twoFactorCode,
    email,
  }: TwoFactorVerificationQueryProps): Promise<TwoFactorVerificationProps> {
    if (!email) throw new ResourceNotFoundError();

    // Find 2FA token using email
    const twoFactorToken =
      await this.usersTokens.findTwoFactorTokenByEmail(email);

    if (!twoFactorToken) throw new UserInvalidTwoFactorCodeError();

    const user = await this.user.findUserByEmail(twoFactorToken.email);
    if (!user) throw new ResourceNotFoundError();

    /* c8 ignore next */
    if (user.email !== email) throw new UserInvalidCodeForUserError();

    // Checks if the provided code matches the stored code
    const isCodeValid = await compare(twoFactorCode, twoFactorToken.token);
    if (!isCodeValid) throw new UserInvalidTwoFactorCodeError();

    const now = new Date();

    // Checks if the token has expired
    if (now > twoFactorToken.expires) throw new UserExpiredCodeError();

    await assertSessionEligible(user, this.driver);

    await this.usersTokens.deleteTwoFactorToken(twoFactorToken.id);

    const existingConfirmation =
      await this.usersTokens.findTwoFactorConfirmationByUserId(user.id);

    if (existingConfirmation) {
      await this.usersTokens.deleteTwoFactorConfirmation(
        existingConfirmation.id,
      );
    }

    try {
      await this.usersTokens.createTwoFactorConfirmation(user.id);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar confirmar a sua verificação de dois fatores! Por favor, tente novamente.",
        500,
      );
    }

    const session = await createUserSession(user, this.usersTokens);

    return { ...session, role: user.role };
  }
}

export { TwoFactorVerificationUseCase };
