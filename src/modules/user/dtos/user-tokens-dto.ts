interface CreateUserRefreshTokenProps {
  userId: string;
  expires_in: Date;
  token_hash: string;
  jti: string;
  family_id: string;
}

interface UserRefreshTokenProps {
  id: string;
  userId: string;
  expires_in: Date;
  user?: {
    role: string;
  };
  token_hash: string;
  jti: string;
  family_id: string;
  revoked_at?: Date | null;
  replaced_by_jti?: string | null;
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
  token_hash: string;
  jti: string;
}

interface RotateUserRefreshTokenProps {
  user_id: string;
  current_jti: string;
  current_token_hash: string;
  replacement: CreateUserRefreshTokenProps;
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
  RotateUserRefreshTokenProps,
};
