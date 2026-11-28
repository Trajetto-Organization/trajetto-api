import { AppError } from "@/shared/errors/AppError";

/**
 * The refusals of removing and anonymizing a login (plano-escala F3-27),
 * each with its own code: the screen words them.
 */
class UserAlreadyAnonymizedError extends AppError {
  constructor() {
    super(
      "Este usuário já foi removido e anonimizado.",
      409,
      "USER_ALREADY_ANONYMIZED",
    );
  }
}

/**
 * A driver's app login: the person is the driver, whose data the driver's
 * own removal takes together with the login's.
 */
class UserIsDriverLoginError extends AppError {
  constructor() {
    super(
      "Este usuário é o login de um motorista: remova e anonimize o motorista na tela Motoristas, que leva o login junto.",
      409,
      "USER_IS_DRIVER_LOGIN",
    );
  }
}

export { UserAlreadyAnonymizedError, UserIsDriverLoginError };
