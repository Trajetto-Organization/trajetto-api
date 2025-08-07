class RefreshTokenNotExistsError extends Error {
  constructor() {
    super("O token de atualização não existe!");
  }
}

export { RefreshTokenNotExistsError };
