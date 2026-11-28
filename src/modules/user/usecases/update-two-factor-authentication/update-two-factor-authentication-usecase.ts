import { inject, injectable } from "tsyringe";

import { compareSecret } from "@/shared/security/bcrypt-gate";
import { IUserRepository } from "../../repositories/IUser-repository";
import { hasMailbox } from "../../services/user-mailbox";

import { ResourceNotFoundError } from "../errors/resource-not-found-error";
import { TwoFactorRequiresEmailError } from "../errors/two-factor-requires-email-error";
import { UserUpdateUserPasswordNotMatchError } from "../errors/user-update-user-password-not-match-error";
import { AppError } from "@/shared/errors/AppError";

interface UpdateTwoFactorAuthenticationProps {
  userId: string;

  /**
   * The state wanted and the current password (wave 2). Absent = the
   * deprecated blind toggle of the release before, kept for the web image
   * serving during the rollout.
   */
  change?: { enabled: boolean; password: string };
}

interface TwoFactorState {
  /** The state the account is in now. */
  enabled: boolean;
  /** Whether this request changed it (false: it already was). */
  changed: boolean;
}

/**
 * PATCH /user/twofactor: the person turns the e-mailed second factor on or
 * off.
 *
 * It was a blind toggle, with no body and no password (wave 2, critique 6): a
 * retry after a timeout undid the change, and a session somebody else held
 * switched the factor off. Now the request says the state it wants — the
 * same state again is a 200 that changes nothing — and proves the current
 * password, refused like the password change refuses it (400
 * PASSWORD_CURRENT_INCORRECT: a 401 here would read as an expired session to
 * both clients, which renew and then sign the person out).
 *
 * The code travels by e-mail, so an account without one cannot turn it on
 * (409 TWO_FACTOR_REQUIRES_EMAIL) — the old toggle stored a check that never
 * asked anything. The blind toggle stays one release for the web image in
 * the rollout (the controller logs each use), under that same refusal.
 */
@injectable()
class UpdateTwoFactorAuthenticationUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({
    userId,
    change,
  }: UpdateTwoFactorAuthenticationProps): Promise<TwoFactorState> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const current = Boolean(findUser.two_factor_enabled);

    if (change) {
      const passwordMatches = await compareSecret(
        change.password,
        findUser.password,
      );

      if (!passwordMatches) throw new UserUpdateUserPasswordNotMatchError();
    }

    const wanted = change ? change.enabled : !current;

    if (wanted === current) return { enabled: current, changed: false };

    if (wanted && !hasMailbox(findUser)) {
      throw new TwoFactorRequiresEmailError();
    }

    try {
      await this.user.updateTwoFactorAuthentication({
        userId,
        isTwoFactorEnabled: wanted,
      });
    } catch (error) {
      throw new AppError(
        "Não foi possível atualizar sua autenticação de dois fatores! Por favor, Tente novamente.",
        500,
      );
    }

    return { enabled: wanted, changed: true };
  }
}

export { UpdateTwoFactorAuthenticationUseCase };
export type { TwoFactorState };
