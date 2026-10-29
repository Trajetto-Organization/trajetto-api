import { AppError } from "@/shared/errors/AppError";

/**
 * The user is the author of records the platform keeps on purpose — delivery
 * events (a tower decision among them), imports, proof reviews, chat
 * messages. Their foreign keys are RESTRICT: deleting the person would erase
 * who did what. Revoking the access keeps the history and ends the login.
 */
class UserHasRecordsError extends AppError {
  constructor() {
    super(
      "Não é possível excluir este usuário porque ele tem registros na operação (por exemplo, eventos de entrega, decisões da torre, importações ou mensagens). Revogue o acesso dele: o login é encerrado e o histórico fica preservado.",
      409,
      "USER_HAS_RECORDS",
    );
  }
}

export { UserHasRecordsError };
