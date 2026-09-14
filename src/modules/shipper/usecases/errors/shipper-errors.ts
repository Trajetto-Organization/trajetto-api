class ShipperNotFoundError extends Error {
  constructor() {
    super("Embarcador não encontrado! Por favor, tente novamente.");
  }
}

class ShipperNameAlreadyExistsError extends Error {
  constructor() {
    super("Já existe um embarcador com este nome nesta empresa.");
  }
}

class ShipperNotBelongBusinessError extends Error {
  constructor() {
    super("Este embarcador não pertence à empresa informada.");
  }
}

class ShipperHasDeliveriesError extends Error {
  constructor(details: string) {
    super(
      `Não é possível excluir este embarcador. ${details} ` +
        "O histórico das entregas depende dele — desative o embarcador para " +
        "ocultá-lo de novos cadastros sem perder o histórico.",
    );
  }
}

export {
  ShipperNotFoundError,
  ShipperNameAlreadyExistsError,
  ShipperNotBelongBusinessError,
  ShipperHasDeliveriesError,
};
