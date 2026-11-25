import { AppError } from "@/shared/errors/AppError";
import {
  ROUTE_STATUS_LABELS,
  type RouteStatus,
} from "@/shared/route/route-rules";

import {
  type DeliveryAlreadyOnRouteError,
  RoutePlanStaleError,
  RouteStopsLimitError,
} from "../errors/route-errors";

/**
 * The most open stops one route holds (decision 14.7, D11). Equal to the
 * reorder's own ceiling: a route that could be built bigger than it can be
 * reordered was a route nobody could fix.
 */
const ROUTE_MAX_STOPS = 200;

/** The add/move batch ceiling, per request. */
const ROUTE_STOPS_BATCH_MAX = 100;

/**
 * Delivery events that describe the PLAN, not the operation: a stop added to
 * or taken off a route that has not left. The tower feed reads what happened
 * on the street and skips these.
 */
const PLANNING_EVENT_TYPES = ["ROUTE_ADDED", "ROUTE_REMOVED"] as const;

/**
 * Whether plan changes write those two types on the delivery's trail.
 *
 * It was off until every reader knew them: the delivery timeline builder,
 * its documented enum, the public events feed (which leaves them out) and the
 * web timeline's KIND_META (which dereferenced the kind and crashed the
 * delivery dialog on an unknown one). All of them do now — the web carries
 * both kinds and a fallback for any newer one since its 1.1.0 — so it is on:
 * a cancelled route's "Rota N cancelada: motivo" line (K8) is one of these.
 * Kept as a constant so the tests read one switch.
 */
const PLANNING_TIMELINE_EVENTS_ENABLED = true;

/**
 * The version check every plan write makes under the route lock. Absent
 * `expected` keeps the old contract (last writer wins) for clients that do
 * not send it yet.
 */
function assertPlanVersion(
  current: number,
  expected: number | undefined,
): void {
  if (expected !== undefined && expected !== current) {
    throw new RoutePlanStaleError(current);
  }
}

/** The 409s and 400s the plan writes share, as HTTP answers. */
function planWriteFailure(error: unknown): AppError | null {
  if (error instanceof RoutePlanStaleError) {
    return new AppError(error.message, 409, "ROUTE_PLAN_STALE");
  }

  if (error instanceof RouteStopsLimitError) {
    return new AppError(error.message, 400, "ROUTE_STOPS_LIMIT");
  }

  return null;
}

/**
 * The routes that still take new stops (K12, decision D30): planned,
 * released and running — a running one at the end of its order. The same
 * list the repository locks the route with (APPENDABLE_STATUSES), which
 * decides again under the lock; this one answers before any read of the
 * deliveries, so the refusal can say which route and why.
 */
const ROUTE_APPENDABLE_STATUSES: readonly RouteStatus[] = [
  "PLANNED",
  "RELEASED",
  "IN_PROGRESS",
];

/**
 * Why this route takes no new stops, naming it and its state, or null when
 * it does (owner's report of 25/11/2026).
 *
 * A route cancelled on another screen stayed in the "Adicionar à rota" list
 * of an open tab, and choosing it answered "Essas entregas já estão nesta
 * rota." — the dispatcher could not tell the route was gone. Checked before
 * the idempotent "already on this route" shortcut and before the deliveries,
 * so an ended route always answers as an ended route. Same 409
 * ROUTE_STATUS_CONFLICT the lock answers: the code every client already
 * reads as "the route moved, refresh"; the sentence is what changed.
 */
function routeNotAppendable(route: {
  code: number;
  status: RouteStatus;
}): AppError | null {
  if (ROUTE_APPENDABLE_STATUSES.includes(route.status)) return null;

  const state =
    route.status === "CANCELLED"
      ? "foi cancelada"
      : route.status === "COMPLETED"
        ? "foi concluída"
        : `está "${ROUTE_STATUS_LABELS[route.status]}"`;

  return new AppError(
    `A Rota ${route.code} ${state} e não aceita novas entregas. Atualize a lista e escolha outra rota.`,
    409,
    "ROUTE_STATUS_CONFLICT",
  );
}

/**
 * The 409 of a write whose route lock found the route no longer appendable
 * (RouteStatusConflictError): it ended between the use case's check and the
 * lock. Read again so the answer names the state it is in now, as the check
 * before the write does; a read that fails or finds it still open (another
 * route of the same write moved: a move's source) answers `fallback`.
 */
async function routeConflictAfterLock(
  reread: () => Promise<{ code: number; status: RouteStatus } | null>,
  fallback: string,
): Promise<AppError> {
  const now = await reread().catch(() => null);
  const ended = now ? routeNotAppendable(now) : null;

  return ended ?? new AppError(fallback, 409, "ROUTE_STATUS_CONFLICT");
}

/**
 * "Já está na Rota 12": the 409 names where each delivery is, so the
 * dispatcher can drop it from the selection or go move it (§4.3).
 */
function alreadyOnRouteMessage(
  elsewhere: Array<{ deliveryId: string; routeCode: number }>,
  labelOf: (deliveryId: string) => string,
): string {
  const byRoute = new Map<number, string[]>();

  for (const entry of elsewhere) {
    byRoute.set(entry.routeCode, [
      ...(byRoute.get(entry.routeCode) ?? []),
      labelOf(entry.deliveryId),
    ]);
  }

  const parts = [...byRoute.entries()]
    .sort(([a], [b]) => a - b)
    .map(([code, labels]) => `${labels.join(", ")} (Rota ${code})`);

  return elsewhere.length === 1
    ? `A entrega ${parts[0]} já está em outra rota. Atualize a lista e tente novamente.`
    : `Estas entregas já estão em outra rota: ${parts.join("; ")}. Atualize a lista e tente novamente.`;
}

/**
 * A delivery's name in a refusal: its code, else the recipient, else the
 * id — the label every "já está na Rota N" of this module uses.
 */
function deliveryLabelOf(
  deliveries: ReadonlyArray<{
    id?: string;
    code?: string | null;
    recipient_name?: string | null;
  }>,
): (deliveryId: string) => string {
  return (deliveryId) => {
    const found = deliveries.find((entry) => entry.id === deliveryId);

    return found?.code ?? found?.recipient_name ?? deliveryId;
  };
}

/** A delivery's open stop, as findOpenStopRoutes answers it. */
interface HeldDelivery {
  deliveryId: string;
  routeId: string;
  routeCode: number;
}

/** What naming the deliveries after a lost race needs. */
interface RaceContext {
  /** The deliveries' open stops now (findOpenStopRoutes, tenant-scoped). */
  reread: (deliveryIds: string[]) => Promise<HeldDelivery[]>;

  /** The delivery's name on screen: its code, else the recipient. */
  labelOf: (deliveryId: string) => string;

  /**
   * A stop the write expected, so not the one it lost to: the route being
   * written (its own stops are not "another route") and, for a move, the
   * sources it was taking the deliveries from (the rollback left them
   * there).
   */
  expected?: (held: HeldDelivery) => boolean;
}

/**
 * The 409 of a write the partial unique index route_stop_active_delivery_idx
 * refused: a colleague put one of these deliveries on a route between the
 * check before the write (which names them) and the insert. The index says
 * nothing about which, so the transaction is gone and the deliveries' open
 * stops are read again, to answer as that check does — "A entrega 123 já
 * está em outra rota (Rota 8)" — instead of the selection's size and a
 * "rota em andamento" that was not true of a planned or released one
 * (audit of 25/11/2026). A read that fails or finds nothing elsewhere
 * answers the error's own sentence, which claims neither. Same 409
 * DELIVERY_ALREADY_ON_ROUTE either way.
 */
async function alreadyOnRouteAfterRace(
  error: DeliveryAlreadyOnRouteError,
  { reread, labelOf, expected }: RaceContext,
): Promise<AppError> {
  const ids = [...new Set(error.deliveryIds)];
  const now = ids.length > 0 ? await reread(ids).catch(() => []) : [];
  const elsewhere = now.filter((entry) => !expected?.(entry));

  if (elsewhere.length === 0) {
    return new AppError(error.message, 409, "DELIVERY_ALREADY_ON_ROUTE");
  }

  return new AppError(
    alreadyOnRouteMessage(elsewhere, labelOf),
    409,
    "DELIVERY_ALREADY_ON_ROUTE",
  );
}

export {
  PLANNING_EVENT_TYPES,
  PLANNING_TIMELINE_EVENTS_ENABLED,
  ROUTE_APPENDABLE_STATUSES,
  ROUTE_MAX_STOPS,
  ROUTE_STOPS_BATCH_MAX,
  alreadyOnRouteAfterRace,
  alreadyOnRouteMessage,
  assertPlanVersion,
  deliveryLabelOf,
  planWriteFailure,
  routeConflictAfterLock,
  routeNotAppendable,
};
export type { RaceContext };
