import { AppError } from "@/shared/errors/AppError";

class UserDriverInactiveError extends AppError {
  constructor() {
    super(
      "Seu cadastro como motorista está inativo! Para acessar a plataforma novamente, por favor contate o administrador.",
      403,
      "AUTH_DRIVER_INACTIVE",
    );
  }
}

export { UserDriverInactiveError };
