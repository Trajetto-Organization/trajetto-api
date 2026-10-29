import { AppError } from "@/shared/errors/AppError";

/**
 * The idempotency key exists in this company, but it was not this driver's.
 *
 * Returning the stored record would hand one driver another driver's
 * submission — the vehicle, the mileage, the litres, the cost and the key to
 * the photo — on the strength of a guessed identifier. The key is scoped
 * `(businessId, client_submission_id)` in the database, so the tenant is
 * already safe; this is the layer below it.
 *
 * A conflict rather than a "not found": the key really is taken, and creating
 * a second record under it would break the unique index anyway. The caller's
 * app should mint a new key and resubmit, which is what it does for every
 * other conflict.
 */
class SubmissionOwnerMismatchError extends AppError {
  constructor() {
    super(
      "Esta submissão já foi registrada por outro motorista. Gere um novo " +
        "envio e tente novamente.",
      409,
      "SUBMISSION_OWNER_MISMATCH",
    );
  }
}

export { SubmissionOwnerMismatchError };
