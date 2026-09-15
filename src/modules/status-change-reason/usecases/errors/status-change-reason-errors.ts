class StatusChangeReasonNotFoundError extends Error {
  constructor() {
    super("Motivo de mudança de status não encontrado! Por favor, tente novamente.");
  }
}

class StatusChangeReasonNameAlreadyExistsError extends Error {
  constructor() {
    super("Já existe um motivo com este nome nesta empresa.");
  }
}

class StatusChangeReasonNotBelongBusinessError extends Error {
  constructor() {
    super("Este motivo não pertence à empresa informada.");
  }
}

/**
 * The same answer the occurrence-type catalogue gives, for the same reason:
 * the trail has to keep naming what happened. A reason cited by an event that
 * disappeared would leave support reading "status alterado — motivo: (nada)"
 * about a decision somebody made deliberately.
 */
class StatusChangeReasonInUseError extends Error {
  constructor(eventCount: number) {
    super(
      `Não é possível excluir este motivo: ele já explica ${eventCount} ` +
        `mudança(s) de status no histórico. Desative-o para tirá-lo das ` +
        `opções sem apagar o que já foi respondido.`,
    );
  }
}

export {
  StatusChangeReasonNotFoundError,
  StatusChangeReasonNameAlreadyExistsError,
  StatusChangeReasonNotBelongBusinessError,
  StatusChangeReasonInUseError,
};
