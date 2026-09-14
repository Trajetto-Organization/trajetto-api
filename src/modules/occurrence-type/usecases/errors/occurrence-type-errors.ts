class OccurrenceTypeNotFoundError extends Error {
  constructor() {
    super("Tipo de ocorrência não encontrado! Por favor, tente novamente.");
  }
}

class OccurrenceTypeNameAlreadyExistsError extends Error {
  constructor() {
    super("Já existe um tipo de ocorrência com este nome nesta empresa.");
  }
}

class OccurrenceTypeNotBelongBusinessError extends Error {
  constructor() {
    super("Este tipo de ocorrência não pertence à empresa informada.");
  }
}

class OccurrenceTypeInUseError extends Error {
  constructor(details: string) {
    super(
      `Não é possível excluir este tipo de ocorrência. ${details} ` +
        "A trilha precisa continuar nomeando o que aconteceu — desative o " +
        "tipo para ocultá-lo de novos registros sem apagar o histórico.",
    );
  }
}

export {
  OccurrenceTypeNotFoundError,
  OccurrenceTypeNameAlreadyExistsError,
  OccurrenceTypeNotBelongBusinessError,
  OccurrenceTypeInUseError,
};
