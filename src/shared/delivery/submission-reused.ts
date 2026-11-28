import { AppError } from "@/shared/errors/AppError";

/**
 * A driver's submission key that already names something else (item K13).
 *
 * `client_submission_id` is unique on the whole delivery_event and
 * delivery_occurrence tables, but every replay lookup is scoped to the
 * company. So the same key can be "taken" in two ways the replay cannot
 * answer as a replay:
 *
 *  - by another company: its row is invisible here, yet the global unique
 *    index refuses the insert (it used to surface as a 500, which the app's
 *    outbox retries forever);
 *  - by another fact of this company (another delivery, another kind of
 *    event): answering it as a replay told the driver a fact was recorded
 *    that never was.
 *
 * Either way the key can never pass, so it is a 409 the app files for review,
 * not a failure worth retrying. Same code as "a caminho" has always given.
 */
function submissionReused(): AppError {
  return new AppError(
    "Esta chave de envio já foi usada em outro registro. Gere uma chave nova e envie de novo.",
    409,
    "SUBMISSION_ID_REUSED",
  );
}

export { submissionReused };
