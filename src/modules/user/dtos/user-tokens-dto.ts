interface CreateUserRefreshTokenProps {
  userId: string;
  expires_in: Date;
  refresh_token: string;
}

interface UserRefreshTokenProps {
  id: string;
  userId: string;
  expires_in: Date;
  user?: {
    role: string;
  };
  refresh_token: string;
}

interface VerificationToken {
  id: string;
  email: string;
  token: string;
  expires: Date;
}

interface CreateVerificationToken {
  email: string;
  token: string;
  expires: Date;
}

interface TokenByIdAndRefreshTokenProps {
  user_id: string;
  refresh_token: string;
}

interface CreateTwoFactorToken {
  email: string;
  token: string;
  expires: Date;
}

interface TwoFactor {
  id: string;
  email: string;
  token: string;
  expires: Date;
}

interface TwoFactorConfirmation {
  id: string;
  userId: string;
}

export {
  CreateUserRefreshTokenProps,
  UserRefreshTokenProps,
  CreateVerificationToken,
  TokenByIdAndRefreshTokenProps,
  VerificationToken,
  TwoFactorConfirmation,
  CreateTwoFactorToken,
  TwoFactor,
};
