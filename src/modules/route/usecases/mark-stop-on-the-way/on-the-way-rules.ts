/**
 * "A caminho" (decision 6.4): the rules, apart from any database.
 *
 * A driver works one address at a time. Marking a stop "a caminho" says "this
 * is where I am heading now"; it is a fact about the stop (its
 * `on_the_way_at`) and an event in the delivery's trail. Marking another stop
 * later does NOT erase the first one's instant — the trail and the customer
 * message already happened — but only the latest mark of a route is
 * "current": see `currentOnTheWayStopId`.
 */

type OnTheWayRefusalCode = "ROUTE_NOT_IN_PROGRESS" | "ROUTE_STOP_NOT_PENDING";

interface OnTheWayRefusal {
  code: OnTheWayRefusalCode;
  message: string;
}

/**
 * Why a stop cannot be marked now, or null when it can.
 *
 * Only a route on the street has a driver heading anywhere, and only a stop
 * nobody has worked yet can be headed to: an ARRIVED stop has the driver at
 * the door, and a resolved or cancelled one is over. Both are 409s — the
 * request is well formed, the state says no.
 */
function onTheWayRefusal(state: {
  routeStatus: string;
  stopStatus: string;
}): OnTheWayRefusal | null {
  if (state.routeStatus !== "IN_PROGRESS") {
    return {
      code: "ROUTE_NOT_IN_PROGRESS",
      message:
        "Só é possível avisar que está a caminho com a rota em andamento. Inicie a rota no aplicativo antes.",
    };
  }

  if (state.stopStatus !== "PENDING") {
    return {
      code: "ROUTE_STOP_NOT_PENDING",
      message:
        "Esta parada não está mais pendente: a chegada, a entrega ou a ocorrência já foi registrada.",
    };
  }

  return null;
}

/**
 * The instant a mark records.
 *
 * The phone's tap (already moved onto the server's clock and bounded by
 * resolveOccurredAt), but never before the route left: the button only
 * exists on a running route, so an earlier instant is two phone clocks
 * disagreeing by a few seconds, and the departure is the honest floor. No tap
 * means "now".
 */
function onTheWayInstant({
  occurredAt,
  startedAt,
  now,
}: {
  occurredAt: Date | null | undefined;
  startedAt: Date | null | undefined;
  now: Date;
}): Date {
  if (!occurredAt) return now;

  if (startedAt && occurredAt.getTime() < startedAt.getTime()) {
    return new Date(startedAt.getTime());
  }

  return occurredAt;
}

/**
 * What the stop keeps: the latest time the driver said so. A second mark of
 * the same stop that reaches the API out of order (an older tap) must not
 * move the stop back in time and make an older stop look current.
 */
function laterOf(previous: Date | null | undefined, next: Date): Date {
  if (previous && previous.getTime() > next.getTime()) return previous;

  return next;
}

/**
 * How old a mark may be and still tell the customer.
 *
 * "Está a caminho" promises that the driver is coming now. A tap that only
 * reaches the API an hour later (a dead zone) is history, not news: the stop
 * and the trail record it, the customer is not told something that stopped
 * being true while the phone had no signal.
 */
const CUSTOMER_NOTICE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Whether this mark tells the person waiting.
 *
 * Once per stop: only the FIRST mark (the stop had no `on_the_way_at`). A
 * driver who marks, turns to another address and comes back has already told
 * this customer once; a second "a caminho" teaches them to ignore the next
 * message. The template and the contact are the pipeline's decision, not
 * this one's (delivery-customer-policy).
 */
function shouldNoticeCustomer({
  previousOnTheWayAt,
  at,
  now,
}: {
  previousOnTheWayAt: Date | null | undefined;
  at: Date;
  now: Date;
}): boolean {
  if (previousOnTheWayAt) return false;

  return now.getTime() - at.getTime() <= CUSTOMER_NOTICE_MAX_AGE_MS;
}

interface StopOnTheWayState {
  id: string;
  status: string;
  on_the_way_at: Date | string | null | undefined;
}

/**
 * The stop that is "a caminho" right now, or null.
 *
 * The stop holding the route's LATEST `on_the_way_at`, and only while it is
 * still PENDING. A driver goes to one address at a time: marking B after A
 * makes B current and leaves A pending (its instant stays, as history). When
 * the latest-marked stop is arrived at or resolved, nothing is current — an
 * older mark does not come back to life. Ties (two marks in the same
 * millisecond) go to the greater id, so every screen picks the same stop.
 */
function currentOnTheWayStopId(
  stops: ReadonlyArray<StopOnTheWayState>,
): string | null {
  let latest: { id: string; status: string; at: number } | null = null;

  for (const stop of stops) {
    if (!stop.on_the_way_at) continue;

    const at = new Date(stop.on_the_way_at).getTime();

    if (Number.isNaN(at)) continue;

    if (
      !latest ||
      at > latest.at ||
      (at === latest.at && stop.id > latest.id)
    ) {
      latest = { id: stop.id, status: stop.status, at };
    }
  }

  return latest && latest.status === "PENDING" ? latest.id : null;
}

export {
  CUSTOMER_NOTICE_MAX_AGE_MS,
  currentOnTheWayStopId,
  laterOf,
  onTheWayInstant,
  onTheWayRefusal,
  shouldNoticeCustomer,
};
export type { OnTheWayRefusal, OnTheWayRefusalCode, StopOnTheWayState };
