import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";

/**
 * Route state machine, kept pure so it can be unit-tested.
 *
 * Same contract as `delivery-rules`: every status write in the module must
 * pass through `canTransitionRoute` or `canTransitionStop` — there is no other
 * legal way to move a route or a stop. The repository enforces it a second
 * time, with the expected status in the `where`, because four surfaces drive
 * the same route at once and a check that happened a few milliseconds ago is
 * not a check.
 */

type RouteStatus =
  | "PLANNED"
  | "RELEASED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

/**
 * A stop carries its own outcome rather than reading the delivery's, because
 * the same delivery can appear in more than one route over time. A failed
 * delivery re-enters as a NEW stop on another route, and the first stop has to
 * keep saying what happened on that attempt — that record is exactly what the
 * support desk needs in order to answer "what happened to invoice X".
 */
type RouteStopStatus =
  | "PENDING"
  | "ARRIVED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

const ROUTE_STATUS_LABELS: Record<RouteStatus, string> = {
  PLANNED: "Planejada",
  RELEASED: "Liberada",
  IN_PROGRESS: "Em andamento",
  COMPLETED: "Concluída",
  CANCELLED: "Cancelada",
};

const ROUTE_STOP_STATUS_LABELS: Record<RouteStopStatus, string> = {
  PENDING: "Pendente",
  ARRIVED: "No local",
  COMPLETED: "Concluída",
  FAILED: "Insucesso",
  CANCELLED: "Cancelada",
};

/**
 * RELEASED → PLANNED is the dispatcher pulling a route back to edit it, and is
 * only legal while nothing has been executed — see `canUnreleaseRoute`.
 * COMPLETED and CANCELLED are terminal: a route that ran is history, and
 * history does not move.
 */
const ROUTE_TRANSITIONS: Record<RouteStatus, RouteStatus[]> = {
  PLANNED: ["RELEASED", "CANCELLED"],
  RELEASED: ["PLANNED", "IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * PENDING → COMPLETED without passing through ARRIVED is deliberate: the app
 * lets a driver prove a delivery without first announcing the arrival, and
 * refusing that would make the queue reject proofs collected offline in the
 * order the driver actually worked.
 */
const ROUTE_STOP_TRANSITIONS: Record<RouteStopStatus, RouteStopStatus[]> = {
  PENDING: ["ARRIVED", "COMPLETED", "FAILED", "CANCELLED"],
  ARRIVED: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

interface TransitionVerdict {
  allowed: boolean;

  /** Present when blocked — the exact message the user should read. */
  reason: string | null;
}

const refuse = (reason: string): TransitionVerdict => ({
  allowed: false,
  reason,
});

const allow = (): TransitionVerdict => ({ allowed: true, reason: null });

function canTransitionRoute(
  from: RouteStatus,
  to: RouteStatus,
): TransitionVerdict {
  if (from === to) {
    return refuse(`A rota já está "${ROUTE_STATUS_LABELS[from]}".`);
  }

  if (ROUTE_TRANSITIONS[from].includes(to)) return allow();

  return refuse(
    `Não é possível mudar a rota de "${ROUTE_STATUS_LABELS[from]}" ` +
      `para "${ROUTE_STATUS_LABELS[to]}".`,
  );
}

function canTransitionStop(
  from: RouteStopStatus,
  to: RouteStopStatus,
): TransitionVerdict {
  if (from === to) {
    return refuse(`A parada já está "${ROUTE_STOP_STATUS_LABELS[from]}".`);
  }

  if (ROUTE_STOP_TRANSITIONS[from].includes(to)) return allow();

  return refuse(
    `Não é possível mudar a parada de "${ROUTE_STOP_STATUS_LABELS[from]}" ` +
      `para "${ROUTE_STOP_STATUS_LABELS[to]}".`,
  );
}

function isTerminalRouteStatus(status: RouteStatus): boolean {
  return ROUTE_TRANSITIONS[status].length === 0;
}

/**
 * A stop still holding its delivery. These are what the partial unique index
 * covers: while a stop is open, that delivery cannot be put on another route.
 */
function isStopOpen(status: RouteStopStatus): boolean {
  return status === "PENDING" || status === "ARRIVED";
}

interface ReleaseCandidate {
  stopCount: number;
  hasVehicle: boolean;
  isDriverActive: boolean;
}

/**
 * Whether a planned route is ready to be handed to a driver.
 *
 * The vehicle is required here, one step earlier than `IN_PROGRESS` strictly
 * needs it, because "released" is a promise to the driver that the route is
 * workable. Discovering at the truck that no vehicle was assigned costs a
 * phone call and a morning.
 */
function canReleaseRoute(candidate: ReleaseCandidate): TransitionVerdict {
  if (candidate.stopCount === 0) {
    return refuse("A rota não tem nenhuma parada para o motorista executar.");
  }

  if (!candidate.hasVehicle) {
    return refuse("Defina o veículo da rota antes de liberá-la.");
  }

  if (!candidate.isDriverActive) {
    return refuse("Só é possível liberar uma rota para um motorista ativo.");
  }

  return allow();
}

/**
 * Whether a released route can be pulled back for editing.
 *
 * Only while nothing has happened. Once a single stop has been worked, the
 * route is a record of what the driver did, and editing it would rewrite that.
 */
function canUnreleaseRoute(stopStatuses: RouteStopStatus[]): TransitionVerdict {
  const worked = stopStatuses.some((status) => status !== "PENDING");

  if (worked) {
    return refuse(
      "A rota já começou a ser executada e não pode voltar ao planejamento. " +
        "Cancele-a se precisar refazê-la.",
    );
  }

  return allow();
}

/**
 * Whether the route has nothing left to do.
 *
 * This is what closes a route, and it is a consequence rather than an action
 * on purpose: a driver asked to press "finish route" either presses it with a
 * stop still open, or never presses it at all. A route with no stops does NOT
 * close — an empty route was never released, and closing it would invent a
 * completed route that nobody ran.
 */
function isRouteFinished(stopStatuses: RouteStopStatus[]): boolean {
  if (stopStatuses.length === 0) return false;

  return !stopStatuses.some(isStopOpen);
}

/**
 * Sequence numbers for stops appended to a route.
 *
 * Spaced by ten so a stop can be moved between two others by giving it the
 * number in between, without rewriting every row after it. Reordering the
 * whole list still rewrites it (see `resequence`), but the common case —
 * dragging one stop — does not have to.
 */
const SEQUENCE_STEP = 10;

function nextSequence(highestExisting: number | null): number {
  return (highestExisting ?? 0) + SEQUENCE_STEP;
}

/**
 * Renumbers a full manual ordering.
 *
 * Takes the complete list of stop ids in the order the dispatcher dropped
 * them, and returns the number each one gets. The complete list, not a move
 * instruction: two dispatchers dragging at once would otherwise produce an
 * order neither of them chose.
 *
 * There is no version column behind it (this used to claim one). What guards
 * the write is the route row lock `reorderStops` takes first: two reorders of
 * one route queue instead of interleaving, the later complete list wins, and
 * a list that no longer names exactly the route's stops is refused with
 * ROUTE_REORDER_MISMATCH. A route that left meanwhile is refused as well.
 */
function resequence(
  orderedStopIds: string[],
): { id: string; sequence: number }[] {
  return orderedStopIds.map((id, index) => ({
    id,
    sequence: (index + 1) * SEQUENCE_STEP,
  }));
}

/**
 * The route code a search term names, or null when it names none.
 *
 * `code` is a Postgres INTEGER. The old test was `Number.isInteger(Number(term))`,
 * which also accepted "1e3" (code 1000) and a 44-digit NF-e key pasted into
 * the box — Number turns that into 4.4e43, Prisma refuses a value out of the
 * column's range, and the board answered 500. At most nine digits always
 * fits; "Rota 12" and "#12" are what people type when they mean code 12.
 */
function routeCodeFromSearch(term: string | null | undefined): number | null {
  const match = /^(?:rota\s*)?#?\s*(\d{1,9})$/i.exec((term ?? "").trim());

  return match ? Number(match[1]) : null;
}

/** How far along the route is, for the header the driver sees and the panel. */
function routeProgress(stopStatuses: RouteStopStatus[]): {
  done: number;
  total: number;
} {
  // Cancelled stops leave the denominator: they are not work the driver has
  // left to do, and counting them would leave a route stuck at "4 de 5".
  const counted = stopStatuses.filter((status) => status !== "CANCELLED");

  return {
    done: counted.filter((status) => !isStopOpen(status)).length,
    total: counted.length,
  };
}

/**
 * The stop statuses that still hold their delivery. These are exactly what the
 * partial unique index covers, and exactly what an outcome may come FROM.
 */
const OPEN_STOP_STATUSES: RouteStopStatus[] = ["PENDING", "ARRIVED"];

interface StopOutcome {
  /** The statuses this outcome may legally be applied from. */
  from: RouteStopStatus[];
  status: RouteStopStatus;
  arrived_at?: Date;
  completed_at?: Date;

  /**
   * The delivery leaves the route with the stop: its driver/vehicle shadow is
   * cleared, so it is back in the unassigned pool and off the driver's phone.
   */
  releaseDelivery?: boolean;
}

/**
 * What a delivery outcome means for the stop that delivery occupies.
 *
 * The driver acts on a delivery — proved it, reported a problem — and the
 * route only learns about it through this table. Keeping the translation in
 * one pure function is what stops the four call sites that record delivery
 * outcomes from each inventing their own answer; the exhaustive switch makes a
 * new DeliveryStatus fail to compile until somebody decides what it does to a
 * route.
 *
 * Null means "the route has nothing to say about this". IN_TRANSIT is not a
 * stop outcome: leaving for the street does not resolve a stop. Nor is a
 * FAILED delivery reopened as PENDING for a second attempt: it gets a NEW stop
 * on a NEW route rather than reopening the one that failed — the old stop is
 * the record of an attempt that happened.
 *
 * PENDING coming off the street (`from` IN_TRANSIT) is the one exception: the
 * load goes back to base, rescheduled, while the route is still running. Its
 * stop is called off (CANCELLED) and the delivery released from the route —
 * otherwise the stop stayed open on a route that could then never close, the
 * driver kept an address refused at arrival and proof, and the delivery was
 * locked out of every future route by the one-open-stop index. The caller
 * passes where the delivery came FROM for exactly this.
 *
 * `from` is both open statuses for every outcome, including COMPLETED. A proof
 * legitimately lands on a stop that was never marked ARRIVED: the driver
 * worked the street with no signal and the app only ever got the proof out.
 */
function stopOutcomeForDelivery(
  status: DeliveryStatus,
  at: Date,
  previous?: DeliveryStatus,
): StopOutcome | null {
  switch (status) {
    case "DELIVERED":
      return {
        from: OPEN_STOP_STATUSES,
        status: "COMPLETED",
        completed_at: at,
      };

    case "FAILED":
      return { from: OPEN_STOP_STATUSES, status: "FAILED", completed_at: at };

    case "CANCELLED":
      // No completed_at: nothing was accomplished at this address, and
      // `updated_at` already records when it was called off. Same shape the
      // route's own cancellation writes onto its open stops.
      return { from: OPEN_STOP_STATUSES, status: "CANCELLED" };

    case "PENDING":
      return previous === "IN_TRANSIT"
        ? {
            from: OPEN_STOP_STATUSES,
            status: "CANCELLED",
            releaseDelivery: true,
          }
        : null;

    case "IN_TRANSIT":
      return null;

    default: {
      // Exhaustiveness: a status added to DeliveryStatus lands here and fails
      // to compile, instead of silently meaning "nothing happens to the stop".
      const unreachable: never = status;

      return unreachable;
    }
  }
}

/**
 * Arriving is not a delivery status change — the delivery stays IN_TRANSIT —
 * so it has its own outcome. Only from PENDING: a second arrival on a stop
 * already marked ARRIVED must not overwrite the first timestamp, which is the
 * one that says when the driver actually got there.
 */
function arrivalStopOutcome(at: Date): StopOutcome {
  return { from: ["PENDING"], status: "ARRIVED", arrived_at: at };
}

interface RouteCompletionInput {
  /**
   * When the stop that closed the route resolved, by the time of the fact
   * (the outcome's `completed_at`). Absent when the closing act has no time
   * of its own — a cancellation, a load sent back to base.
   */
  closingAt?: Date | null;

  /** The latest resolution among ALL the route's stops, this one included. */
  lastResolvedAt?: Date | null;

  startedAt?: Date | null;
  now: Date;
}

/**
 * When a route that closed itself finished (MOB-08).
 *
 * The last stop to ARRIVE is not always the last to HAPPEN: a proof taken at
 * 10:05 in a dead zone and uploaded at 13:40 closes the route at 13:40, while
 * its stop already says 10:05. Stamping the upload made a route worked until
 * 10:05 read "concluída às 13:40" on the panel, in the tower and in its
 * punctuality.
 *
 * So the route ends when its work did: the closing fact, but never before
 * another stop resolved (the offline proof may be older than one proven
 * online), never before the route left, and never in the future. With no
 * time of its own the close is "now", exactly as before.
 */
function routeCompletedAt({
  closingAt,
  lastResolvedAt,
  startedAt,
  now,
}: RouteCompletionInput): Date {
  if (!closingAt) return now;

  const latest = Math.max(
    closingAt.getTime(),
    lastResolvedAt?.getTime() ?? -Infinity,
    startedAt?.getTime() ?? -Infinity,
  );

  return new Date(Math.min(latest, now.getTime()));
}

export {
  OPEN_STOP_STATUSES,
  ROUTE_STATUS_LABELS,
  ROUTE_STOP_STATUS_LABELS,
  ROUTE_STOP_TRANSITIONS,
  ROUTE_TRANSITIONS,
  SEQUENCE_STEP,
  canReleaseRoute,
  canTransitionRoute,
  canTransitionStop,
  canUnreleaseRoute,
  isRouteFinished,
  arrivalStopOutcome,
  isStopOpen,
  isTerminalRouteStatus,
  nextSequence,
  resequence,
  routeCodeFromSearch,
  routeCompletedAt,
  routeProgress,
  stopOutcomeForDelivery,
};

export type {
  ReleaseCandidate,
  RouteCompletionInput,
  StopOutcome,
  RouteStatus,
  RouteStopStatus,
  TransitionVerdict,
};
