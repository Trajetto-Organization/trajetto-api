class UserDriverInactiveError extends Error {
  constructor() {
    super(
      "Seu cadastro como motorista está inativo! Para acessar a plataforma novamente, por favor contate o administrador.",
    );
  }
}

export { UserDriverInactiveError };
