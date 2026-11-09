interface AuthenticateUserProps {
  token?: string;
  refresh_token?: string;
  twoFactorVerificationMessage?: string;
  isTwoFactorVerification?: boolean;
  twoFactorChallenge?: string;
  emailVerificationMessage?: string;
  emailVerification?: boolean;
  role?: string;

  /**
   * With a session (wave 2): the manager set this password, so the client
   * asks for the person's own before anything else. Additive.
   */
  mustChangePassword?: boolean;

  /**
   * The CPF login's company picker (D8): the CPF and password matched in
   * more than one company, so no session was opened. Only the companies
   * where the password matched, by id and name, nothing else.
   */
  businessSelection?: { id: string; name: string }[];
}

/** POST /user/session with the driver's CPF (plan of 02/11/2026, D8). */
interface CpfLoginProps {
  /** The 11 digits, already normalized and checked by the schema. */
  cpf: string;
  password: string;

  /** The company picked after a previous answer listed several. */
  businessId?: string;

  /**
   * The phone, which the session is then bound to (D4). Required in effect
   * (wave 2): without it, or on a phone no login of the CPF trusts, the
   * login is refused with AUTH_DEVICE_NOT_TRUSTED.
   */
  deviceId?: string | null;
}

// The code, its hash and the verification token are made inside each flow,
// so a login that needs neither never pays for them.
interface TwoFactorProps {
  email: string;
  userId: string;
  name: string;
  sessionVersion?: number;

  /** A CPF login's phone (wave 2): the challenge binds the code step to it. */
  deviceHash?: string;
}

interface EmailVerificationProps {
  /** Names the account in the log when the e-mail cannot be sent. */
  userId: string;
  email: string;
  name: string;
}

export {
  AuthenticateUserProps,
  CpfLoginProps,
  TwoFactorProps,
  EmailVerificationProps,
};
