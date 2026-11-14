import { AppError } from "@/shared/errors/AppError";

/**
 * A driver's login that already left a history (events, occurrences,
 * messages…) cannot be handed to another driver (decision D-37, 14/11/2026).
 * Those rows point at the login, not at the Driver: moved, the new driver's
 * work and the previous one's would read as one person's. A new login keeps
 * them apart; without history, moving is allowed as before.
 *
 * `history` is the counted history (user-history-rules).
 */
class UserDriverLockedError extends AppError {
  constructor(history: string) {
    super(
      `Não é possível passar este login para outro motorista: ele já tem registros na operação (${history}), que ficariam misturados com os do novo motorista. Crie outro login para o novo motorista; se este não for mais usado, revogue o acesso dele.`,
      409,
      "USER_DRIVER_LOCKED",
    );
  }
}

export { UserDriverLockedError };
