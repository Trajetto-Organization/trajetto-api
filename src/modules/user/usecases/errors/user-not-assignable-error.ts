import { AppError } from "@/shared/errors/AppError";

/**
 * The person chosen as a record's responsible or assignee no longer signs
 * in: their access was revoked, or the login was removed and anonymized
 * (the USER_ANONYMIZE job keeps the row as "Usuário removido"). Their own
 * code, not the "not found" of a foreign id: the user IS of this company
 * (that check runs first), so saying why leaks nothing and tells the person
 * what to do.
 */
class UserNotAssignableError extends AppError {
  constructor() {
    super(
      "Este usuário não tem mais acesso ao sistema. Escolha outra pessoa.",
      400,
      "USER_NOT_ASSIGNABLE",
    );
  }
}

export { UserNotAssignableError };
