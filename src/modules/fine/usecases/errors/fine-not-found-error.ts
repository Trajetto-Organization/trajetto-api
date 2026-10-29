import { AppError } from "@/shared/errors/AppError";

/**
 * A fine that does not exist and one of another company answer alike: a
 * distinct refusal would confirm that the other company's fine exists.
 */
class FineNotFoundError extends AppError {
  constructor() {
    super("Multa não encontrada!", 404, "FINE_NOT_FOUND");
  }
}

export { FineNotFoundError };
