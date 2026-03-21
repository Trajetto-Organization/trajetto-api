class UserRefreshTokenNotExistsError extends Error {
  constructor() {
    super("O token de atualização não existe!");
  }
}

export { UserRefreshTokenNotExistsError };
