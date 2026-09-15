import { inject, injectable } from "tsyringe";

import { compare } from "bcrypt";

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

    /**
     * Quantas vezes já tentaram ESTE código.
     *
     * Sem contador, um palpite errado não consumia nada e não contava para
     * nada: o código tem seis dígitos, vale quinze minutos, e a única barreira
     * era o rate limit — que era contornável pelo cabeçalho que o cliente
     * escreve. Um milhão de possibilidades com tentativas ilimitadas é um
     * código que se adivinha.
     *
     * O limite é verificado ANTES da comparação, para que o palpite de número
     * seis não seja nem comparado; e o incremento vem do banco, nunca de um
     * read-then-write, senão duas tentativas simultâneas contariam uma.
     */
    if (twoFactorToken.attempts >= MAX_TWO_FACTOR_ATTEMPTS) {
      // Apagado: passar do teto queima o código. Continuar aceitando
      // tentativas num código travado seria um oráculo de "este e-mail tem
      // 2FA pendente" que dura quinze minutos.
      await this.usersTokens.deleteTwoFactorToken(twoFactorToken.id);

      throw new UserInvalidTwoFactorCodeError();
    }

    // Checks if the provided code matches the stored code
    const isCodeValid = await compare(twoFactorCode, twoFactorToken.token);

    if (!isCodeValid) {
      const attempts = await this.usersTokens.countTwoFactorAttempt(
        twoFactorToken.id,
      );

      if (attempts >= MAX_TWO_FACTOR_ATTEMPTS) {
        await this.usersTokens.deleteTwoFactorToken(twoFactorToken.id);
      }

      // A MESMA recusa de um código inexistente ou queimado. Uma mensagem
      // distinta para "você errou cinco vezes" contaria ao atacante que ele
      // estava no e-mail certo.
      throw new UserInvalidTwoFactorCodeError();
    }

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
