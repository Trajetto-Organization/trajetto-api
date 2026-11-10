import { resolveTimeZone, wallClock } from "@/shared/time/business-day";

import type { DriverPause, DriverPauseKind } from "../dtos/driver-pause-dto";

/** The longest note a pause keeps, after normalization. */
const PAUSE_NOTE_MAX = 200;

/**
 * The shortest reason a pause that requires one takes (owner, 09/11/2026),
 * in non-space characters of the cleaned note: the same 3 as the
 * refuelling's "Outro motivo". Against a slip of the thumb, not bad faith:
 * "WC" is refused, "pneu" taken. The app holds its own copy under the same name
 * (trajetto-mobile, features/pauses/pause-rules.ts), pinned to this one by
 * tests/unitaires/contract/app-reading-windows.test.ts.
 */
const PAUSE_NOTE_MIN_LENGTH = 3;

/**
 * The first app contract (`contract` in x-trajetto-client-version) whose
 * form asks for the reason of the generic pause, and so the first the
 * server refuses a start without it from.
 */
const PAUSE_NOTE_RULE_CONTRACT = 7;

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
function pauseStartedAtFromEnd(
  resolvedStart: Date | null,
  endedAt: Date,
): Date {
  if (!resolvedStart || resolvedStart.getTime() > endedAt.getTime()) {
    return new Date(endedAt);
  }

  return resolvedStart;
}

/** Whole minutes between two instants, rounded down (never overstated). */
function wholeMinutes(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
}

/**
 * How long after a pause ends the driver waits to START another (owner,
 * 05/11/2026: the app let a driver toggle the pause on and off over and
 * over). A fixed number, not a company setting, and short on purpose: Lei
 * 13.103/2015 lets the 30-minute driving rest be split (CTB art. 67-C) and
 * the meal is at least an hour (CLT art. 71 and 235-C), so nothing here
 * delays a rest the law asks for, and ending a pause is never refused. It
 * only stops the on/off spam. The app holds its own copy under the same
 * name (trajetto-mobile, features/pauses/pause-rules.ts), pinned to this one
 * by tests/unitaires/contract/app-reading-windows.test.ts.
 */
const PAUSE_COOLDOWN_MINUTES = 5;

const PAUSE_COOLDOWN_MS = PAUSE_COOLDOWN_MINUTES * 60_000;

/**
 * Slack for the clock correction. The tap is the phone's, moved onto the
 * server's clock by its send stamp (resolveOccurredAt), so a start the app
 * allowed by its own clock may land a few seconds early here. Only the
 * refusal uses it; what the answers show never does.
 */
const PAUSE_COOLDOWN_TOLERANCE_MS = 30_000;

/**
 * The first app contract (`contract` in x-trajetto-client-version,
 * CLIENT_CONTRACT in trajetto-mobile/utils/client-version.ts) whose build
 * holds the cooldown itself, and so the first the server refuses a start
 * inside it from. The same release as the arrival checklist's rule and the
 * second refuelling's question.
 */
const PAUSE_COOLDOWN_RULE_CONTRACT = 5;

/** What the app reads about the cooldown (GET /current and the 409). */
interface PauseCooldownView {
  /** ISO; the driver's latest ended pause, any day. Null when none. */
  last_ended_at: string | null;

  /** ISO; last_ended_at + PAUSE_COOLDOWN_MINUTES. Null when none. */
  next_pause_allowed_at: string | null;

  /**
   * Whole seconds from the server's now until next_pause_allowed_at,
   * rounded up; 0 once it passed or with no ended pause. The app counts
   * down on its own clock from this, never from the instant: phones' clocks
   * are often wrong, and the app must never block longer than the server.
   */
  next_pause_in_seconds: number;
}

interface PauseCooldown extends PauseCooldownView {
  /** Whether a new start at the tap falls inside the cooldown. */
  blocks: boolean;
}

/** The cooldown as the app reads it, measured from the server's `now`. */
function pauseCooldownView(
  lastEndedAt: Date | null,
  now: Date,
): PauseCooldownView {
  const ended = lastEndedAt ? new Date(lastEndedAt).getTime() : Number.NaN;

  if (Number.isNaN(ended)) {
    return {
      last_ended_at: null,
      next_pause_allowed_at: null,
      next_pause_in_seconds: 0,
    };
  }

  const allowedAt = ended + PAUSE_COOLDOWN_MS;

  return {
    last_ended_at: new Date(ended).toISOString(),
    next_pause_allowed_at: new Date(allowedAt).toISOString(),
    next_pause_in_seconds: Math.max(
      0,
      Math.ceil((allowedAt - now.getTime()) / 1000),
    ),
  };
}

/**
 * Whether a NEW start tapped at `tap` (the corrected tap) falls inside the
 * cooldown of the driver's previous pause, the one that ended at
 * `lastEndedAt`: less than PAUSE_COOLDOWN_MINUTES between that end and the
 * tap, minus PAUSE_COOLDOWN_TOLERANCE_MS. A tap before that end (a negative
 * gap: two clocks, or an overlap) is inside it too. No previous pause, or a
 * date that cannot be read, never blocks. Plus the view the answers show,
 * from the server's `now`, without the tolerance.
 *
 * Who is refused for it is enforcesPauseCooldown's call, never this one's.
 */
function pauseCooldown({
  lastEndedAt,
  tap,
  now,
}: {
  lastEndedAt: Date | null;
  tap: Date;
  now: Date;
}): PauseCooldown {
  const view = pauseCooldownView(lastEndedAt, now);

  if (view.last_ended_at === null) return { blocks: false, ...view };

  const gap = tap.getTime() - new Date(view.last_ended_at).getTime();

  return {
    blocks: gap < PAUSE_COOLDOWN_MS - PAUSE_COOLDOWN_TOLERANCE_MS,
    ...view,
  };
}

/**
 * Whether a start inside the cooldown is refused (409 PAUSE_COOLDOWN)
 * instead of recorded: only when the driver can still be told, and so only
 * for the start of a NEW pause (a resend of a start that got in is answered
 * before any rule, and ending a pause never asks).
 *
 * - from a build that holds the cooldown itself (contract
 *   PAUSE_COOLDOWN_RULE_CONTRACT on): an older one — mobile `main` sends no
 *   header, nor does the web — never offered the wait, and its outbox would
 *   fail what it could not avoid;
 * - sent now, not by the app's offline queue (X-Client-Queued-At): the tap
 *   happened earlier, and refusing it would park a real pause on the
 *   driver's pending screen over a time rule.
 *
 * The caller is a driver: the start refuses anybody else first
 * (assertPauseDriver).
 */
function enforcesPauseCooldown(request: {
  clientContract: number | null | undefined;
  queued: boolean;
}): boolean {
  return (
    typeof request.clientContract === "number" &&
    request.clientContract >= PAUSE_COOLDOWN_RULE_CONTRACT &&
    !request.queued
  );
}

/**
 * Whether a cleaned note (normalizePauseNote) is too short to say why the
 * pause was taken: fewer than PAUSE_NOTE_MIN_LENGTH non-space characters.
 * No note at all is too short too.
 */
function pauseNoteTooShort(note: string | null): boolean {
  return (note ?? "").replace(/\s/g, "").length < PAUSE_NOTE_MIN_LENGTH;
}

/**
 * Whether a start of a type that requires a reason (pauseTypeRequiresNote)
 * without one is refused (400 PAUSE_NOTE_REQUIRED) instead of recorded —
 * the cooldown's shape (enforcesPauseCooldown):
 *
 * - from a build whose form asks for it (contract PAUSE_NOTE_RULE_CONTRACT
 *   on): an older one — mobile `main` sends no header, nor does the web —
 *   never asked, and its outbox would fail what it could not avoid;
 * - sent now, not by the app's offline queue (X-Client-Queued-At): its body
 *   is the one the driver tapped, and the queue resends the same body after
 *   an update, so a refusal there would never end.
 *
 * Only the start of a NEW pause: a resend of a start that got in is
 * answered before any rule, and ending a pause never asks for a reason.
 */
function enforcesPauseNote(request: {
  clientContract: number | null | undefined;
  queued: boolean;
}): boolean {
  return (
    typeof request.clientContract === "number" &&
    request.clientContract >= PAUSE_NOTE_RULE_CONTRACT &&
    !request.queued
  );
}

/**
 * "14:05", the wall clock of the company's zone (h23), of the instant
 * truncated to its minute, or rounded up to the next one (see
 * pauseCooldownMessage).
 */
function minuteClock(
  at: Date,
  timeZone: string,
  round: "down" | "up" = "down",
): string {
  const minutes = at.getTime() / 60_000;
  const whole = round === "up" ? Math.ceil(minutes) : Math.floor(minutes);
  const { hour, minute } = wallClock(
    new Date(whole * 60_000),
    resolveTimeZone(timeZone),
  );

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * The refusal's sentence, in the company's zone. The end reads as every
 * other screen shows it (truncated to its minute); the next start is
 * rounded UP to its minute, so a start tapped at the minute shown is always
 * accepted, tolerance or not. That is also the minute the app (contract 5)
 * puts on its disabled button and in its own notice, counted on the phone's
 * clock from next_pause_in_seconds; it shows this sentence only when no
 * seconds came.
 */
function pauseCooldownMessage(lastEndedAt: Date, timeZone: string): string {
  const ended = new Date(lastEndedAt);
  const allowed = new Date(ended.getTime() + PAUSE_COOLDOWN_MS);

  return `Você encerrou uma pausa às ${minuteClock(ended, timeZone)}. Uma nova pausa fica disponível às ${minuteClock(allowed, timeZone, "up")}.`;
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
      typeName !== undefined
        ? { id: pause.occurrenceTypeId, name: typeName }
        : null,
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
  PAUSE_COOLDOWN_MINUTES,
  PAUSE_COOLDOWN_RULE_CONTRACT,
  PAUSE_COOLDOWN_TOLERANCE_MS,
  PAUSE_NOTE_MAX,
  PAUSE_NOTE_MIN_LENGTH,
  PAUSE_NOTE_RULE_CONTRACT,
  enforcesPauseCooldown,
  enforcesPauseNote,
  normalizePauseNote,
  pauseCooldown,
  pauseCooldownMessage,
  pauseCooldownView,
  pauseEndedAt,
  pauseNoteTooShort,
  pauseStartedAtFromEnd,
  toPauseView,
  wholeMinutes,
};
export type { PauseCooldown, PauseCooldownView, PauseView };
