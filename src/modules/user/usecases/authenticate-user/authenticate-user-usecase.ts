import { inject, injectable } from "tsyringe";

import crypto from "node:crypto";

import { compareSecret } from "@/shared/security/bcrypt-gate";

import { v4 as uuidV4 } from "uuid";

import {
  AuthenticateUserProps,
  CpfLoginProps,
  EmailVerificationProps,
  TwoFactorProps,
} from "./dtos/authenticate-user-dto";

import { AuthenticateUser, DriverLoginByCpf } from "../../dtos/user-dto";
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
  hashDeviceId,
  normalizeSessionDeviceId,
} from "../../services/session-service";
import { IDriverTrustedDeviceRepository } from "../../repositories/IDriver-trusted-device-repository";
import { UserDeviceNotTrustedError } from "../errors/user-device-not-trusted-error";
import { isLoginLocked } from "@/shared/security/login-lockout-rules";
import {
  refusalClock,
  refusalPaddingMs,
} from "@/shared/security/refusal-pacing";
import { DRIVER_LOGINS_BY_CPF_LIMIT } from "../../repositories/IUser-repository";
import { hashOneTimeCode } from "@/shared/security/one-time-code";
import { issueTwoFactorChallenge } from "../../services/two-factor-challenge";
import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";
import { logger } from "@/shared/logging/logger";
import { hasMailbox, requireMailbox } from "../../services/user-mailbox";

const log = logger.child({ component: "user" });

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

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("UsersTokensRepository")
    private usersTokens: IUsersTokensRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("DriverTrustedDeviceRepository")
    private trustedDevices: IDriverTrustedDeviceRepository,
  ) {}

  private async emailVerification({
    userId,
    email,
    name,
  }: EmailVerificationProps) {
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
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar enviar o código de verificação! Por favor, tente novamente.",
        500,
      );
    }

    /**
     * Sent after the answer, never before it.
     *
     * The login waited on the SMTP round trip to Resend (10 s timeouts): a
     * slow provider held the request past the edge's patience and a failing
     * one answered 500 to a right password. The token is stored above, and
     * logging in again issues a new link, so a lost e-mail costs one more
     * attempt. It carries a secret, so it stays in-process, off the outbox.
     */
    void sendTransactionalMail({
      email,
      name,
      subject: "Verificação de e-mail",
      templateName: "email-verification.hbs",
      moduleName: "user",
      additionalVariablesProperties: {
        url: `${this.http_request}/new-verification?token=${tokenVerification}`,
        logo: emailLogoUrl(),
      },
    }).catch((error) =>
      // The provider's error is already redacted (no address).
      log.error(
        { err: error, userId },
        "e-mail verification link could not be sent",
      ),
    );

    return {
      emailVerificationMessage:
        "Um token de verificação foi enviado para este e-mail!",
      emailVerification: true,
    };
  }

  private async twoFactor({
    userId,
    email,
    name,
    sessionVersion,
    deviceHash,
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
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar enviar o código de verificação! Por favor, tente novamente.",
        500,
      );
    }

    /**
     * Sent after the answer, never before it, like the resend
     * (resend-two-factor-code). The code is stored above, and the code
     * screen's "reenviar" issues another with the challenge returned here, so
     * a lost e-mail costs one resend instead of a login held on SMTP or a 500
     * after a right password. It carries a secret: in-process, off the outbox.
     */
    void sendTransactionalMail({
      email,
      name,
      subject: "Código de verificação de dois fatores",
      templateName: "two-factor-verification-code.hbs",
      moduleName: "user",
      additionalVariablesProperties: {
        token: twoFactorToken,
        logo: emailLogoUrl(),
      },
    }).catch((error) =>
      log.error(
        { err: error, userId },
        "two-factor code e-mail could not be sent",
      ),
    );

    return {
      twoFactorVerificationMessage:
        "Um código de verificação foi enviado para este e-mail!",
      isTwoFactorVerification: true,
      // The proof that the password was right, for the code step (WEB-07);
      // from a CPF login, with the phone the session will be bound to.
      twoFactorChallenge: issueTwoFactorChallenge(
        {
          id: userId,
          email,
          session_version: sessionVersion,
        },
        deviceHash,
      ),
    };
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
        userId: findUser.id,
        // Signed in by this address, so it has one (D2: only a driver's
        // login may not, and it never signs in by e-mail).
        email: requireMailbox(findUser),
        name: findUser.name,
      });
    }

    if (findUser.two_factor_enabled) {
      return await this.twoFactor({
        email: requireMailbox(findUser),
        name: findUser.name,
        userId: findUser.id,
        sessionVersion: findUser.session_version,
      });
    }

    const session = await createUserSession(findUser, this.usersTokens, client);

    return {
      ...session,
      role: findUser.role,
      mustChangePassword: findUser.must_change_password ?? false,
    };
  }

  /**
   * The driver's login by CPF and password (plan of 02/11/2026, D8; decision
   * D02), the alternative to the QR code.
   *
   * The CPF is unique per company only, so it may name logins in several:
   * the password is compared with each, and the company is chosen among the
   * ones where it matched — never listed before, so a CPF alone says nothing
   * about where it is registered. One match: the session opens. Several: the
   * answer lists them (id and name) and the app asks again with the company.
   *
   * The brakes are the e-mail login's: the per-address route limit, and the
   * per-account lock (login-lockout-rules) on EVERY login of the CPF — a
   * wrong password counts against all of them, so guessing by CPF is braked
   * exactly like guessing by e-mail. A failure is counted only when the
   * password matched nowhere: a driver entering company A with A's password
   * is not guessing B's.
   *
   * No e-mail verification (decision D01: the driver proves the CPF and the
   * password, and may have no mailbox); the second factor still applies to a
   * login that has an e-mail and turned it on.
   *
   * The phone comes first (wave 2, 06/11/2026; owner's decision): the CPF is
   * public, so CPF and password are tried only against the logins that trust
   * this phone — the ones a QR code entered on it (driver_trusted_device).
   * The filter runs right after the CPF lookup and before any bcrypt; none
   * left (an unknown CPF, no `deviceId`, a phone no login trusts) is one
   * refusal, 403 AUTH_DEVICE_NOT_TRUSTED, with no comparison and nothing
   * counted towards the lock — so a stranger's phone can no longer lock a
   * driver out by guessing. Every session it opens is the phone-bound one.
   *
   * One more way a login trusts the phone, read in the same place, before
   * any bcrypt: a live session of that login bound to this very phone (a
   * refresh_token row with its `device_id`, neither revoked nor expired).
   * During the rollout the previous image opened such sessions, by QR code
   * and by CPF, after the migration's backfill and without trusting the
   * phone; the driver signing in again on it would hear "peça o QR Code".
   * The phone is trusted then (source `backfill`), once, instead of a manual
   * rerun of the backfill. From this release on every phone-bound session
   * already comes with the trust, and every way the trust goes (the manager,
   * "Aparelhos conectados", D5, the login moved to another driver) ends
   * those sessions first, so this re-grants only what the backfill would
   * have. Never from the consumed QR code: a phone the previous image
   * disconnected kept that row.
   *
   * Every refusal after that lasts as long as DRIVER_LOGINS_BY_CPF_LIMIT
   * comparisons (shared/security/refusal-pacing): one bcrypt per login, then
   * a sleep for the ones skipped, so the clock does not tell in how many
   * companies the CPF signs in — and a guess costs no more CPU than before.
   */
  async executeByCpf({
    cpf,
    password,
    businessId,
    deviceId,
  }: CpfLoginProps): Promise<AuthenticateUserProps> {
    let compared = 0;
    let comparingMs = 0;

    const compare = async (hash: string): Promise<boolean> => {
      const startedAt = refusalClock.now();

      try {
        return await compareSecret(password, hash);
      } finally {
        compared += 1;
        comparingMs += refusalClock.now() - startedAt;
      }
    };

    const refuse = async (
      ...args: ConstructorParameters<typeof UserInvalidCredentialsError>
    ): Promise<never> => {
      const padding = refusalPaddingMs(
        comparingMs,
        compared,
        DRIVER_LOGINS_BY_CPF_LIMIT,
      );

      if (padding > 0) await refusalClock.sleep(padding);

      throw new UserInvalidCredentialsError(...args);
    };

    // No phone, nothing to trust: refused before anything is read.
    if (!deviceId) throw new UserDeviceNotTrustedError(false);

    const now = new Date();
    const deviceHash = hashDeviceId(deviceId);
    const found = await this.user.findDriverLoginsByCpf(cpf);
    const foundIds = found.map((login) => login.id);

    // Asked even for an unknown CPF, so it costs the same round trips as a
    // known one on a phone nobody trusts.
    const trusting = new Set(
      await this.trustedDevices.trustingLogins(foundIds, deviceHash, now),
    );
    const untrusted = foundIds.filter((id) => !trusting.has(id));

    // A phone the rollout left out (see above): a live session of the login
    // on it vouches for it. Asked for an unknown CPF too, for the same reason.
    if (untrusted.length > 0 || foundIds.length === 0) {
      const signedIn = await this.usersTokens.findLoginsSignedInOnDevice(
        untrusted,
        normalizeSessionDeviceId(deviceId),
        now,
      );

      for (const userId of signedIn) {
        await this.trustedDevices.trust({
          userId,
          deviceHash,
          source: "backfill",
          now,
        });
        trusting.add(userId);

        log.info(
          { event: "auth.device_trust_restored", userId },
          "phone trusted from its live phone-bound session",
        );
      }
    }

    const logins = found.filter((login) => trusting.has(login.id));

    if (logins.length === 0) throw new UserDeviceNotTrustedError(true);

    const matched: DriverLoginByCpf[] = [];
    const missed: DriverLoginByCpf[] = [];

    for (const login of logins) {
      // Compared even when locked, as by e-mail: the time a refusal takes
      // does not say which account is locked.
      const matches = await compare(login.password);

      if (isLoginLocked(login, now)) continue;

      (matches ? matched : missed).push(login);
    }

    const soleId = logins.length === 1 ? logins[0].id : undefined;

    if (matched.length === 0) {
      await Promise.all(
        missed.map((login) => this.user.registerFailedLogin(login.id, now)),
      );

      return refuse(
        missed.length > 0 ? "wrong_password" : "account_locked",
        soleId,
      );
    }

    const candidates =
      businessId === undefined
        ? matched
        : matched.filter((login) => login.businessId === businessId);

    // A company the password does not open: the same refusal as a wrong
    // password, so the picker cannot be probed with ids.
    if (candidates.length === 0) {
      return refuse("company_not_matched", soleId);
    }

    const eligible: DriverLoginByCpf[] = [];
    let refusal: AppError | null = null;

    for (const login of candidates) {
      try {
        await assertSessionEligible(login, this.driver);
        eligible.push(login);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;

        refusal ??= error;
      }
    }

    // The password was right: the driver hears why (inactive, revoked…), as
    // by e-mail. An inactive login is never offered in the picker.
    if (eligible.length === 0) throw refusal!;

    if (eligible.length > 1) {
      return {
        businessSelection: eligible.map((login) => ({
          id: login.businessId!,
          name: login.companyName,
        })),
      };
    }

    const [chosen] = eligible;

    // A burst of guesses may have locked it while this password was compared.
    if (!(await this.user.clearFailedLogins(chosen.id, now))) {
      throw new UserInvalidCredentialsError("account_locked", chosen.id);
    }

    // The password matched on this phone.
    await this.trustedDevices.recordLogin(chosen.id, deviceHash, now);

    if (chosen.two_factor_enabled && hasMailbox(chosen)) {
      return await this.twoFactor({
        email: chosen.email,
        name: chosen.name,
        userId: chosen.id,
        sessionVersion: chosen.session_version,
        // The code step binds the session to this phone, and only this
        // phone may finish it.
        deviceHash,
      });
    }

    // The long phone-bound session (D4), on the phone that is trusted.
    const session = await createUserSession(
      chosen,
      this.usersTokens,
      "driver_device",
      deviceId,
    );

    return {
      ...session,
      role: chosen.role,
      mustChangePassword: chosen.must_change_password ?? false,
    };
  }
}

export { AuthenticateUserUseCase };
