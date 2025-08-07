interface AuthenticateUserProps {
  token?: string;
  refresh_token?: string;
  twoFactorVerificationMessage?: string;
  isTwoFactorVerification?: boolean;
  emailVerificationMessage?: string;
  emailVerification?: boolean;
  role?: string;
}

interface TwoFactorProps {
  email: string;
  userId: string;
  name: string;
  hashedTwoFactorToken: string;
  twoFactorExpires: Date;
  twoFactorToken: string;
}

interface EmailVerificationProps {
  email: string;
  name: string;
  tokenVerification: string;
  expires: Date;
}

export { AuthenticateUserProps, TwoFactorProps, EmailVerificationProps };
