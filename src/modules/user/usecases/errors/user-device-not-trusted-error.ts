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
 */
class UserDeviceNotTrustedError extends AppError {
  /** Whether the request named a phone at all, for the log line only. */
  readonly withDevice: boolean;

  constructor(withDevice: boolean) {
    super(
      "Não foi possível entrar com este CPF neste aparelho. Confira o CPF ou peça ao gestor o QR Code de acesso.",
      403,
      "AUTH_DEVICE_NOT_TRUSTED",
    );

    this.withDevice = withDevice;
  }
}

export { UserDeviceNotTrustedError };
