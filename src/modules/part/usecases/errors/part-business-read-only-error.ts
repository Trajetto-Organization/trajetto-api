import { AppError } from "@/shared/errors/AppError";

/**
 * A part never changes company: its order lines and prices are the history
 * of what that company spent. Only a master reaches this — the tenant gate
 * stops anyone else naming another company — and the part is theirs to
 * edit, so a "not found" would be false here.
 */
class PartBusinessReadOnlyError extends AppError {
  constructor() {
    super(
      "A empresa de uma peça não pode ser alterada.",
      400,
      "PART_BUSINESS_READ_ONLY",
    );
  }
}

export { PartBusinessReadOnlyError };
