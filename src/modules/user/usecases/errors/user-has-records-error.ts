import { AppError } from "@/shared/errors/AppError";

/**
 * The user is the author of records the platform keeps on purpose — delivery
 * events (a tower decision among them), occurrences, proof reviews, chat
 * messages, imports. Their foreign keys are RESTRICT: deleting the person
 * would erase who did what. Revoking the access keeps the history and ends
 * the login.
 *
 * `records` is the counted history ("12 evento(s) de entrega e 3 mensagem(ns)
 * no chat", user-history-rules). Without it — a foreign key the count does
 * not know, or a row gone again before the recount — the sentence falls back
 * to examples.
 */
class UserHasRecordsError extends AppError {
  constructor(records?: string) {
    super(
      records
        ? `Não é possível excluir este usuário porque ele tem registros na operação: ${records}. Em vez de excluir, revogue o acesso dele em "Revogar acesso": o login é encerrado e o histórico fica preservado.`
        : 'Não é possível excluir este usuário porque ele tem registros na operação (por exemplo, eventos de entrega, decisões da torre, importações ou mensagens). Em vez de excluir, revogue o acesso dele em "Revogar acesso": o login é encerrado e o histórico fica preservado.',
      409,
      "USER_HAS_RECORDS",
    );
  }
}

export { UserHasRecordsError };
