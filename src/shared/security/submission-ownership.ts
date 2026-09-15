/**
 * May this caller be handed the record stored under an idempotency key?
 *
 * The keys are unique per `(businessId, client_submission_id)`, so a replay
 * can never cross carriers. Inside one carrier it could: the early return
 * that answers a retry runs BEFORE the driver-ownership check, so a guessed
 * identifier read back another driver's submission — the vehicle, the
 * mileage, the litres, the cost and the key to the photo.
 *
 * Three cases, and only one of them refuses.
 */
function submissionBelongsToCaller(
  callerDriverId: string | null | undefined,
  recordDriverId: string | null | undefined,
): boolean {
  /**
   * A caller who is not a driver is already bounded by the tenant check.
   *
   * Dispatchers and administrators are meant to see the whole company's
   * records; narrowing them here would break the dashboard's own retries.
   */
  if (!callerDriverId) return true;

  /**
   * A record with no driver was created from the dashboard.
   *
   * It belongs to the company rather than to a person, so there is no
   * personal scope to violate.
   */
  if (!recordDriverId) return true;

  return recordDriverId === callerDriverId;
}

export { submissionBelongsToCaller };
