import { AppError } from "@/shared/errors/AppError";

/** The driver was already removed and anonymized (plano-escala F3-27). */
class DriverAlreadyAnonymizedError extends AppError {
  constructor() {
    super(
      "Este motorista já foi removido e anonimizado.",
      409,
      "DRIVER_ALREADY_ANONYMIZED",
    );
  }
}

export { DriverAlreadyAnonymizedError };
