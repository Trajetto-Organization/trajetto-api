class UserAlreadyExistsError extends Error {
  constructor() {
    super(
      "Este usuário não está disponível para cadastro. Os usuários devem ser únicos em todo o sistema.",
    );
  }
}

export { UserAlreadyExistsError };
