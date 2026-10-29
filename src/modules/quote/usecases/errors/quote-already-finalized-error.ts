import { AppError } from "@/shared/errors/AppError";

class QuoteAlreadyFinalizedError extends AppError {
  constructor() {
    super(
      "Não é possível atualizar orçamentos que já foram fechados ou convertidos.",
      409,
      "QUOTE_ALREADY_FINALIZED",
    );
  }
}

export { QuoteAlreadyFinalizedError };
