interface AuthenticateUserProps {
  token?: string;
  refresh_token?: string;
  twoFactorVerificationMessage?: string;
  isTwoFactorVerification?: boolean;
  twoFactorChallenge?: string;
  emailVerificationMessage?: string;
  emailVerification?: boolean;
  role?: string;
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

export { AuthenticateUserProps, TwoFactorProps, EmailVerificationProps };
