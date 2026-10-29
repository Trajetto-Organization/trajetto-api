import { randomBytes, randomUUID } from "node:crypto";

import { env } from "@/env";
import { AppError } from "@/shared/errors/AppError";

import { IUsersTokensRepository } from "../repositories/IUsers-tokens-repository";

/**
 * A password never travels by e-mail (decision 4.9). Whoever creates an
 * account, or an administrator who resets one, sends a single-use link to the
 * page where the person picks the password themselves.
 *
 * The link is the forgot-password token the product already spends on
 * /forgot/password (hashed at rest, single use, refused once expired), so
 * there is one way to set a password by link, not two drifting copies.
 */

/** A new account: the person may read the welcome e-mail days later. */
const NEW_ACCOUNT_LINK_TTL_MS = 72 * 60 * 60 * 1000;

/** A reset asked for by an administrator: the person is expecting it. */
const ADMIN_RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The password an account holds until its owner sets one through the link.
 * Random and never shown to anyone: it only exists because the column is
 * NOT NULL. 32 bytes of the OS generator, not Math.random.
 */
function unusablePassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Stores a fresh link for `email` and returns the URL to put in the e-mail.
 * The store keeps one row per address (an upsert), so the previous link
 * stops working. The row keeps only the token's hash; the raw value exists
 * here and in the link.
 */
async function issuePasswordSetupLink(
  usersTokens: IUsersTokensRepository,
  email: string,
  ttlMs: number,
  now: Date = new Date(),
): Promise<string> {
  const token = randomUUID();

  await usersTokens.createForgotPasswordVerificationToken({
    email,
    token,
    expires: new Date(now.getTime() + ttlMs),
  });

  return `${env.HTTP_REQUEST}/forgot/password?token=${token}`;
}

/**
 * The reset link asked for could not be stored. Raised before anything is
 * written, so the whole request changed nothing and the master can simply
 * try again — instead of reading "atualizado com sucesso" for a link that
 * never existed.
 */
class PasswordLinkUnavailableError extends AppError {
  constructor() {
    super(
      "Não foi possível gerar o link de redefinição de senha. Nada foi alterado; tente novamente em instantes.",
      503,
      "PASSWORD_LINK_UNAVAILABLE",
    );
  }
}

export {
  PasswordLinkUnavailableError,
  ADMIN_RESET_LINK_TTL_MS,
  NEW_ACCOUNT_LINK_TTL_MS,
  issuePasswordSetupLink,
  unusablePassword,
};
