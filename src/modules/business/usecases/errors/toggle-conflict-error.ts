import { AppError } from "@/shared/errors/AppError";

/**
 * Somebody flipped the same switch while this request was deciding, so
 * nothing was written.
 *
 * A toggle reads the current value and writes its opposite. Two people acting
 * at the same moment therefore read the same state and write the same
 * opposite: two clicks, one change, and each of them believes they caused it.
 * On the deactivate path that matters twice over, because the write also
 * disconnects every session of the company — the second request would send
 * that broadcast for a change it did not make.
 *
 * A 409 rather than a silent success: the screen the caller is looking at is
 * out of date, and only they can decide whether they still want the flip.
 */
class ToggleConflictError extends AppError {
  constructor(subject: string) {
    super(
      `O status ${subject} mudou enquanto você trabalhava nele e nada foi ` +
        "gravado. Atualize a tela e tente novamente.",
      409,
      "TOGGLE_CONFLICT",
    );
  }
}

export { ToggleConflictError };
