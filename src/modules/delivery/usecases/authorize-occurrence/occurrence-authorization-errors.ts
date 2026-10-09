import { AppError } from "@/shared/errors/AppError";

import type { OccurrenceAuthorizationStatus } from "../../dtos/delivery-dto";

/** Missing and another company's read the same (decision 11.3). */
class OccurrenceNotFoundError extends AppError {
  constructor() {
    super("Ocorrência não encontrada.", 404, "OCCURRENCE_NOT_FOUND");
  }
}

/** The report never asked the tower: there is nothing to approve or deny. */
class OccurrenceAuthorizationNotRequiredError extends AppError {
  constructor() {
    super(
      "Esta ocorrência não pede autorização da torre.",
      409,
      "OCCURRENCE_AUTHORIZATION_NOT_REQUIRED",
    );
  }
}

class AuthorizationNoteRequiredError extends AppError {
  constructor() {
    super(
      "Diga ao motorista por que o pedido foi negado.",
      400,
      "AUTHORIZATION_NOTE_REQUIRED",
    );
  }
}

interface SettledDecision {
  status: Exclude<OccurrenceAuthorizationStatus, "NOT_REQUIRED" | "PENDING">;
  authorizedBy: { id: string; name: string } | null;
  authorized_at: Date | null;
  note: string | null;
}

/**
 * Somebody got there first: another operator, or the driver's proof
 * (SUPERSEDED). 409 with the decision that stands, so the screen can say
 * who decided what instead of "try again".
 */
class OccurrenceAlreadyDecidedError extends AppError {
  readonly decision: SettledDecision;

  constructor(decision: SettledDecision) {
    const who = decision.authorizedBy?.name;

    const message =
      decision.status === "SUPERSEDED"
        ? "O pedido foi encerrado: a entrega já foi resolvida antes da decisão."
        : decision.status === "APPROVED"
          ? `${who ?? "Outra pessoa"} já autorizou esta ocorrência.`
          : `${who ?? "Outra pessoa"} já negou esta ocorrência.`;

    super(message, 409, "OCCURRENCE_ALREADY_DECIDED");

    this.decision = decision;
  }
}

export {
  AuthorizationNoteRequiredError,
  OccurrenceAlreadyDecidedError,
  OccurrenceAuthorizationNotRequiredError,
  OccurrenceNotFoundError,
  type SettledDecision,
};
