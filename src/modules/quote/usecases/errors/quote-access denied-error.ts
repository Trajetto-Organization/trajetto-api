import { AppError } from "@/shared/errors/AppError";

class QuoteAccessDeniedError extends AppError {
  constructor() {
    super("Acesso negado.", 403, "PERMISSION_DENIED");
  }
}

export { QuoteAccessDeniedError };
