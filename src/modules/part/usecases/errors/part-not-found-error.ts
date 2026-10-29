import { AppError } from "@/shared/errors/AppError";

/**
 * Also the answer for another company's part, in the path or in a body: a
 * 403 "não pertence a esta empresa" confirmed the id exists elsewhere
 * (decision 11.3).
 */
class PartNotFoundError extends AppError {
  constructor() {
    super("Peça não encontrada!", 404, "PART_NOT_FOUND");
  }
}

export { PartNotFoundError };
