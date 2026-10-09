import type { DriverPause, DriverPauseKind } from "../dtos/driver-pause-dto";

/** The longest note a pause keeps, after normalization. */
const PAUSE_NOTE_MAX = 200;

/**
 * A note as it is stored: one line, no spaces at the ends, no runs of spaces
 * (decision 5.3 text rules). Cleaned rather than refused: the note travels in
 * the offline outbox, where a 400 is a permanent failure over a stray space.
 * Empty becomes null.
 */
function normalizePauseNote(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;

  const cleaned = raw.replace(/\s+/g, " ").trim();

  return cleaned.length > 0 ? cleaned : null;
}

/**
 * When a pause ended: the corrected tap (resolveOccurredAt), the receipt time
 * when there is none, and never before the start. A phone clock corrected
 * into the past must not produce a negative pause, and refusing it would park
 * a real gesture on the driver's pending screen.
 */
function pauseEndedAt(
  startedAt: Date,
  resolvedEnd: Date | null,
  now: Date,
): Date {
  const end = resolvedEnd ?? now;

  return end.getTime() < startedAt.getTime() ? new Date(startedAt) : end;
}

/**
 * When a pause started, for an end that arrived before its start (the outbox
 * delivers out of order after a failure). Never after the end; unreadable,
 * the end itself (a zero-length pause is honest about what we know).
 */
function pauseStartedAtFromEnd(resolvedStart: Date | null, endedAt: Date): Date {
  if (!resolvedStart || resolvedStart.getTime() > endedAt.getTime()) {
    return new Date(endedAt);
  }

  return resolvedStart;
}

/** Whole minutes between two instants, rounded down (never overstated). */
function wholeMinutes(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
}

interface PauseView {
  id: string;
  kind: DriverPauseKind;
  started_at: string;
  ended_at: string | null;

  /** Null while the pause is open. */
  duration_minutes: number | null;

  note: string | null;
  routeId: string | null;

  start_submission_id: string;
  end_submission_id: string | null;

  start_latitude: number | null;
  start_longitude: number | null;
  end_latitude: number | null;
  end_longitude: number | null;

  /** Decision 14.4: the PAUSE type chosen; null when its name is unknown. */
  occurrence_type: { id: string; name: string } | null;
}

/** What the driver's routes answer about one pause. */
function toPauseView(
  pause: DriverPause,
  typeNames: ReadonlyMap<string, string> = new Map(),
): PauseView {
  const typeName = typeNames.get(pause.occurrenceTypeId);

  return {
    id: pause.id,
    kind: pause.kind,
    occurrence_type:
      typeName !== undefined ? { id: pause.occurrenceTypeId, name: typeName } : null,
    started_at: pause.started_at.toISOString(),
    ended_at: pause.ended_at ? pause.ended_at.toISOString() : null,
    duration_minutes: pause.ended_at
      ? wholeMinutes(pause.started_at, pause.ended_at)
      : null,
    note: pause.note,
    routeId: pause.routeId,
    start_submission_id: pause.start_submission_id,
    end_submission_id: pause.end_submission_id,
    start_latitude: pause.start_latitude,
    start_longitude: pause.start_longitude,
    end_latitude: pause.end_latitude,
    end_longitude: pause.end_longitude,
  };
}

export {
  PAUSE_NOTE_MAX,
  normalizePauseNote,
  pauseEndedAt,
  pauseStartedAtFromEnd,
  toPauseView,
  wholeMinutes,
};
export type { PauseView };
