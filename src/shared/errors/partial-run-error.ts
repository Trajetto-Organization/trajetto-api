/**
 * A run that did part of its work and stopped with work left (plano-escala
 * F1-17): a purge that hit its time budget or its row ceiling with rows
 * still due.
 *
 * It used to end SUCCEEDED, so nothing ran it again before the next night
 * and a growing backlog looked like a quiet night. Now it ends FAILED with a
 * lastError that starts with "[partial]": no new status, so the previous
 * image reading the table during a rolling deploy sees a FAILED it already
 * knows, and the catch-up sweep tells the two apart by the marker. A partial
 * is retried only inside the partial window, a few times a day
 * (cron-catch-up-decision.ts), and pages only after 26 h of nothing but
 * partials (alert-rules.ts).
 *
 * The job throws it at the END, after every step ran: one purge that ran out
 * of budget must not skip the others.
 */
const PARTIAL_RUN_MARKER = "[partial]";

class PartialRunError extends Error {
  /** What still has rows due, by name: tables or passes, never data. */
  readonly pending: readonly string[];

  constructor(pending: readonly string[]) {
    super(
      `${PARTIAL_RUN_MARKER} parou no orçamento ou no teto com sobra em: ${pending.join(", ")}`,
    );

    this.name = "PartialRunError";
    this.pending = pending;
  }
}

function isPartialRunError(error: unknown): error is PartialRunError {
  return error instanceof PartialRunError;
}

/** Whether a recorded run's lastError is a partial run's. */
function isPartialRunMessage(lastError: string | null | undefined): boolean {
  return (lastError ?? "").startsWith(PARTIAL_RUN_MARKER);
}

/**
 * Throws a PartialRunError naming each part that stopped early; returns when
 * none did.
 */
function throwIfPartial(parts: Record<string, { stoppedEarly: boolean }>) {
  const pending = Object.entries(parts)
    .filter(([, result]) => result.stoppedEarly)
    .map(([name]) => name);

  if (pending.length > 0) throw new PartialRunError(pending);
}

export {
  PARTIAL_RUN_MARKER,
  PartialRunError,
  isPartialRunError,
  isPartialRunMessage,
  throwIfPartial,
};
