import { AppError } from "@/shared/errors/AppError";

class QuoteNotFoundError extends AppError {
  constructor() {
    super("Orçamento não encontrado!", 404, "QUOTE_NOT_FOUND");
  }
}

export { QuoteNotFoundError };
