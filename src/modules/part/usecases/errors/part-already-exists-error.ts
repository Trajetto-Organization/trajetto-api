import { AppError } from "@/shared/errors/AppError";

/** Same description in this company, ignoring case and edge spaces. */
class PartAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe uma peça com esta descrição nesta empresa.",
      409,
      "PART_ALREADY_EXISTS",
    );
  }
}

export { PartAlreadyExistsError };
