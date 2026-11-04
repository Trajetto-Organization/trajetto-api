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

  /** The phone, which the session is then bound to (D4). */
  deviceId?: string | null;
}

// The code, its hash and the verification token are made inside each flow,
// so a login that needs neither never pays for them.
interface TwoFactorProps {
  email: string;
  userId: string;
  name: string;
  sessionVersion?: number;
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
