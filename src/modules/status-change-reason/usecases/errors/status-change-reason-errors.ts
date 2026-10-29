import { AppError } from "@/shared/errors/AppError";

/**
 * Honest HTTP with a code (decision 11.3). Also the answer for a reason of
 * another company: a separate "not yours" refusal would tell a caller which
 * ids exist at other carriers.
 */
class StatusChangeReasonNotFoundError extends AppError {
  constructor() {
    super(
      "Motivo de mudança de status não encontrado! Por favor, tente novamente.",
      404,
      "STATUS_CHANGE_REASON_NOT_FOUND",
    );
  }
}

class StatusChangeReasonNameAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um motivo com este nome nesta empresa.",
      409,
      "STATUS_CHANGE_REASON_NAME_TAKEN",
    );
  }
}

/**
 * The same answer the occurrence-type catalogue gives, for the same reason:
 * the trail has to keep naming what happened. A reason cited by an event that
 * disappeared would leave support reading "status alterado — motivo: (nada)"
 * about a decision somebody made deliberately. 409: the request was well
 * formed, the reason is simply part of the record now.
 */
class StatusChangeReasonInUseError extends AppError {
  constructor(eventCount: number) {
    super(
      `Não é possível excluir este motivo: ele já explica ${eventCount} ` +
        `mudança(s) de status no histórico. Desative-o para tirá-lo das ` +
        `opções sem apagar o que já foi respondido.`,
      409,
      "STATUS_CHANGE_REASON_IN_USE",
    );
  }
}

export {
  StatusChangeReasonNotFoundError,
  StatusChangeReasonNameAlreadyExistsError,
  StatusChangeReasonInUseError,
};
