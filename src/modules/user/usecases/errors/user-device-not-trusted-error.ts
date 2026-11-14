import { AppError } from "@/shared/errors/AppError";

/**
 * The CPF login refused because no login of that CPF trusts this phone
 * (wave 2, 06/11/2026; owner's decision: CPF and password only on a phone
 * that entered that login by the manager's QR code).
 *
 * One answer for an unknown CPF, a request without `deviceId` and a phone no
 * login of the CPF trusts, so the route says nothing about which CPFs exist.
 * It is decided before any password is compared: no bcrypt, no lockout
 * counted — an untrusted phone can no longer lock a driver out by guessing.
 * A 403 with the API's own sentence, which the app builds in the field
 * already show for a code they do not know (signInFailureMessage).
 *
 * The sentence names the two usual causes, a first sign-in on that phone
 * and a phone the company disconnected (14/11/2026): "não foi possível
 * entrar" left the driver retyping the password, which is never compared
 * here. The app keeps the same sentence in
 * trajetto-mobile/features/access/access-messages.ts
 * (DEVICE_NOT_TRUSTED_MESSAGE, which login-refusal-rules.ts shows over the
 * API's since 14/11/2026); the two are the same word for word, so builds
 * from before, which show this one, read alike. It still says nothing
 * about whether the CPF exists.
 */
class UserDeviceNotTrustedError extends AppError {
  /** Whether the request named a phone at all, for the log line only. */
  readonly withDevice: boolean;

  constructor(withDevice: boolean) {
    super(
      "Este aparelho não está liberado para entrar com este CPF. Isso acontece no primeiro acesso em um celular ou quando a empresa desconecta o aparelho. Confira o CPF ou peça ao gestor um QR Code de acesso.",
      403,
      "AUTH_DEVICE_NOT_TRUSTED",
    );

    this.withDevice = withDevice;
  }
}

export { UserDeviceNotTrustedError };
