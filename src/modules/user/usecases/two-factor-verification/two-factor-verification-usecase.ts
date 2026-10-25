import { inject, injectable } from "tsyringe";

import { verifyOneTimeCode } from "@/shared/security/one-time-code";
import { isTwoFactorChallengeFor } from "../../services/two-factor-challenge";

import { IUserRepository } from "../../repositories/IUser-repository";
import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";

import { UserInvalidTwoFactorCodeError } from "../errors/user-invalid-two-factor-code-error";
import { UserExpiredCodeError } from "../errors/user-expired-code-error";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { UserInvalidCodeForUserError } from "../errors/user-invalid-code-for-user-error";

import { AppError } from "@/shared/errors/AppError";
import { MAX_TWO_FACTOR_ATTEMPTS } from "@/shared/security/two-factor-rules";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import { assertSessionEligible } from "../../services/session-eligibility";
import {
  SessionClient,
  createUserSession,
} from "../../services/session-service";

interface TwoFactorVerificationQueryProps {
  twoFactorCode: string;
  email: string;
  /** What the password step returned; see services/two-factor-challenge. */
  challenge?: string;
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

  async execute(
    { twoFactorCode, email, challenge }: TwoFactorVerificationQueryProps,
    client: SessionClient = "web",
  ): Promise<TwoFactorVerificationProps> {
    if (!email) throw new ResourceNotFoundError();

    // Find 2FA token using email
    const twoFactorToken =
      await this.usersTokens.findTwoFactorTokenByEmail(email);

    if (!twoFactorToken) throw new UserInvalidTwoFactorCodeError();

    const user = await this.user.findUserByEmail(twoFactorToken.email);
    if (!user) throw new ResourceNotFoundError();

    /* c8 ignore next */
    if (user.email !== email) throw new UserInvalidCodeForUserError();

    // A code is a SECOND factor. One left pending by an account that has
    // since turned two-factor off is not a way in on its own: a password
    // login no longer deletes pending codes on the way through, since it no
    // longer touches two-factor state at all when two-factor is off.
    if (!user.two_factor_enabled) throw new UserInvalidTwoFactorCodeError();

    // Only next to proof that THIS account's password was just verified
    // (WEB-07). Checked before the attempt counter on purpose: a caller
    // without the password must not be able to burn the owner's guesses.
    if (!isTwoFactorChallengeFor(challenge, user)) {
      throw new UserInvalidTwoFactorCodeError();
    }

    /**
     * Attempts on THIS code. Six digits valid for fifteen minutes is
     * guessable with unlimited tries, so the rate limit is not the only
     * barrier. Checked BEFORE comparing, so the guess past the ceiling is not
     * even compared; the database increments, so concurrent guesses all count.
     */
    if (twoFactorToken.attempts >= MAX_TWO_FACTOR_ATTEMPTS) {
      // Past the ceiling the code is burned: accepting guesses on a locked
      // code would be a fifteen-minute oracle for "this e-mail has a pending
      // 2FA".
      // `consume` and not `delete`: burning a code that a parallel request
      // has already burned is a no-op, not a 500.
      await this.usersTokens.consumeTwoFactorToken(twoFactorToken.id);

      throw new UserInvalidTwoFactorCodeError();
    }

    // Checks if the provided code matches the stored code
    const isCodeValid = await verifyOneTimeCode(
      twoFactorCode,
      twoFactorToken.token,
    );

    if (!isCodeValid) {
      const attempts = await this.usersTokens.countTwoFactorAttempt(
        twoFactorToken.id,
      );

      if (attempts >= MAX_TWO_FACTOR_ATTEMPTS) {
        await this.usersTokens.consumeTwoFactorToken(twoFactorToken.id);
      }

      // The SAME refusal as a missing or burned code: a distinct "too many
      // attempts" would tell an attacker the e-mail was right.
      throw new UserInvalidTwoFactorCodeError();
    }

    const now = new Date();

    // Checks if the token has expired
    if (now > twoFactorToken.expires) throw new UserExpiredCodeError();

    await assertSessionEligible(user, this.driver);

    /**
     * Spend the code, and stop if somebody else already spent it.
     *
     * This used to be a plain `delete` after the check, which is two problems
     * in one line: two requests carrying the same correct code both got past
     * every check and each opened a session, and the second `delete` hit a
     * row that was already gone — Prisma throws on that, so the caller got a
     * 500 instead of an answer. One code, one session, and losing the race
     * reads as what it is: a code that has already been used.
     */
    const spent = await this.usersTokens.consumeTwoFactorToken(
      twoFactorToken.id,
    );

    if (!spent) throw new UserInvalidTwoFactorCodeError();

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

    const session = await createUserSession(user, this.usersTokens, client);

    return { ...session, role: user.role };
  }
}

export { TwoFactorVerificationUseCase };
