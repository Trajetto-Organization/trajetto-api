import { AppError } from "@/shared/errors/AppError";

/**
 * Honest HTTP with a code (decision 11.3). Also the answer for a shipper of
 * another company: a separate "not yours" refusal would tell a caller which
 * ids exist at other carriers.
 */
class ShipperNotFoundError extends AppError {
  constructor() {
    super(
      "Embarcador não encontrado! Por favor, tente novamente.",
      404,
      "SHIPPER_NOT_FOUND",
    );
  }
}

class ShipperNameAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um embarcador com este nome nesta empresa.",
      409,
      "SHIPPER_NAME_TAKEN",
    );
  }
}

/** 409: the request is valid, the shipper is simply part of the record. */
class ShipperHasDeliveriesError extends AppError {
  constructor(details: string) {
    super(
      `Não é possível excluir este embarcador. ${details} ` +
        "O histórico das entregas depende dele — desative o embarcador para " +
        "ocultá-lo de novos cadastros sem perder o histórico.",
      409,
      "SHIPPER_HAS_DELIVERIES",
    );
  }
}

/**
 * A deactivated shipper takes no new deliveries, whatever the door: the form,
 * the edit, the NF-e XML or the spreadsheet (decision 5.7). One sentence, so
 * every door refuses the same way.
 */
class ShipperInactiveError extends AppError {
  constructor(name?: string) {
    super(
      name
        ? `O embarcador ${name} está desativado. Reative-o para registrar entregas dele.`
        : "Este embarcador está inativo. Reative-o para registrar novas entregas.",
      400,
      "SHIPPER_INACTIVE",
    );
  }
}

/** Two shippers of one company cannot share a CNPJ (decision 5.7). */
class ShipperCnpjAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um embarcador com este CNPJ nesta empresa.",
      409,
      "SHIPPER_CNPJ_TAKEN",
    );
  }
}

export {
  ShipperNotFoundError,
  ShipperNameAlreadyExistsError,
  ShipperHasDeliveriesError,
  ShipperInactiveError,
  ShipperCnpjAlreadyExistsError,
};
