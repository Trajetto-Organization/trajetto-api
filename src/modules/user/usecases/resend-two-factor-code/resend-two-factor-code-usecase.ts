import { inject, injectable } from "tsyringe";

import crypto from "node:crypto";

import { hashOneTimeCode } from "@/shared/security/one-time-code";
import { isTwoFactorChallengeFor } from "../../services/two-factor-challenge";

import { IUsersTokensRepository } from "../../repositories/IUsers-tokens-repository";
import { IUserRepository } from "../../repositories/IUser-repository";

import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { logger } from "@/shared/logging/logger";

import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";

const log = logger.child({ component: "user" });

interface ResendTwoFactorCodeProps {
  twoFactorVerificationMessage: string;
}

/**
 * The one answer, whatever the account.
 *
 * This endpoint is anonymous. It used to say "no such account", "no 2FA on
 * this account" or "code resent" — three answers that told anybody which
 * e-mails exist and which have 2FA, the very thing /authenticate and
 * /forgot-password are careful never to reveal.
 */
const NEUTRAL_ANSWER: ResendTwoFactorCodeProps = {
  twoFactorVerificationMessage:
    "Se esta conta tiver a verificação em duas etapas ativa, um novo código foi enviado para o e-mail.",
};

/** How long a code must live before another one may be sent for the account. */
const RESEND_INTERVAL_MS = 60_000;

/** How long a code lives (the `expires` it is stored with). */
const CODE_LIFETIME_MS = 15 * 60 * 1000;

@injectable()
class ResendTwoFactorCodeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,

    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
  ) {}

  async execute(
    email: string,
    challenge?: string,
  ): Promise<ResendTwoFactorCodeProps> {
    const findUser = await this.user.findUserByEmail(email);

    // Nothing to send, and nothing to say about why.
    if (!findUser || !findUser.two_factor_enabled) return NEUTRAL_ANSWER;

    // A code only for whoever just proved this account's password (WEB-07):
    // otherwise the e-mail alone was enough to have codes issued and guess
    // them. Same neutral answer, so the refusal says nothing either.
    if (!isTwoFactorChallengeFor(challenge, findUser)) return NEUTRAL_ANSWER;

    const existingTwoFactorTokenByEmail =
      await this.usersTokens.findTwoFactorTokenByEmail(findUser.email);

    /**
     * One code per account per minute, whoever asks.
     *
     * The route's own limit is per ADDRESS: a flood of codes aimed at one
     * chosen person only needed more addresses. Each resend also replaced the
     * code the person was about to type. A code is issued with a fixed
     * lifetime, so its age is known without another column.
     */
    if (existingTwoFactorTokenByEmail) {
      const issuedAt =
        new Date(existingTwoFactorTokenByEmail.expires).getTime() -
        CODE_LIFETIME_MS;

      if (Date.now() - issuedAt < RESEND_INTERVAL_MS) return NEUTRAL_ANSWER;
    }

    if (existingTwoFactorTokenByEmail) {
      await this.usersTokens.deleteTwoFactorToken(
        existingTwoFactorTokenByEmail.id,
      );
    }

    const twoFactorConfirmation =
      await this.usersTokens.findTwoFactorConfirmationByUserId(findUser.id);

    if (twoFactorConfirmation) {
      await this.usersTokens.deleteTwoFactorConfirmation(
        twoFactorConfirmation.id,
      );
    }

    const twoFactorToken = crypto.randomInt(100_000, 1_000_000).toString();
    const hashedTwoFactorToken = hashOneTimeCode(twoFactorToken);

    const twoFactorExpires = new Date(Date.now() + CODE_LIFETIME_MS);

    await this.usersTokens.createTwoFactorToken({
      email: email,
      token: hashedTwoFactorToken,
      expires: twoFactorExpires,
    });

    /**
     * Sent after the answer, never before it.
     *
     * Awaiting the provider made an account with two-factor on answer
     * hundreds of milliseconds later than any other address, and a provider
     * failure a 500 for those accounts only: the neutral sentence above was
     * undone by the clock and the status code. The code is already stored,
     * so a lost e-mail costs one more "resend". It carries a secret, so it
     * stays in-process and never rides the outbox.
     */
    void sendTransactionalMail({
      email,
      name: findUser.name,
      subject: "Two factor verification code",
      templateName: "two-factor-verification-code.hbs",
      moduleName: "user",
      additionalVariablesProperties: {
        token: twoFactorToken,
        logo: emailLogoUrl(),
      },
    }).catch((error) =>
      // The provider's error is already redacted (no address), and the code
      // itself never reaches a log line.
      log.error(
        { err: error, userId: findUser.id },
        "two-factor code e-mail could not be sent",
      ),
    );

    return NEUTRAL_ANSWER;
  }
}

export { ResendTwoFactorCodeUseCase };
