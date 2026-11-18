import { AppError } from "@/shared/errors/AppError";

import type { Business } from "../../dtos/business-dto";

/**
 * The refusals of the scheduled purge's state machine (plano-escala F3-25),
 * each with its own code: the screen words them, and a MASTER who clicks
 * Reativar on a purge that already started needs to read that it started,
 * not that something failed.
 */
class BusinessPurgeConfirmationError extends AppError {
  constructor() {
    super(
      "Para agendar a exclusão, digite a razão social da empresa exatamente como está cadastrada.",
      400,
      "BUSINESS_PURGE_CONFIRMATION_MISMATCH",
    );
  }
}

/** The state a refusal speaks of, and what the caller was trying. */
function purgeRefusal(
  state: Business["purge_state"],
  attempt: "schedule" | "cancel" | "toggle",
): AppError {
  if (state === "PURGING") {
    return new AppError(
      "A exclusão desta empresa já começou e não pode mais ser desfeita.",
      409,
      "BUSINESS_PURGE_RUNNING",
    );
  }

  if (state === "PURGED") {
    return new AppError(
      "Os dados desta empresa já foram excluídos.",
      409,
      "BUSINESS_PURGED",
    );
  }

  if (state === "SCHEDULED") {
    return attempt === "toggle"
      ? new AppError(
          "A exclusão desta empresa está agendada. Para devolver o acesso, use Reativar, que também cancela a exclusão.",
          409,
          "BUSINESS_PURGE_SCHEDULED",
        )
      : new AppError(
          "A exclusão desta empresa já está agendada.",
          409,
          "BUSINESS_PURGE_ALREADY_SCHEDULED",
        );
  }

  return new AppError(
    "Esta empresa não tem exclusão agendada.",
    409,
    "BUSINESS_PURGE_NOT_SCHEDULED",
  );
}

export { BusinessPurgeConfirmationError, purgeRefusal };
