/**
 * Scene 11, the route half: what the tower's socket (replica A) has to have
 * received about a route driven by a phone pinned to another replica. Every
 * one of these frames is caused on the phone's replica (or by the dispatcher
 * on A) and reaches the tower through the Socket.IO Redis adapter; a frame
 * that never arrives is a board that never moves.
 *
 * Stop by stop, not by count: each "a caminho" and each arrival the API
 * accepted from the phone (VirtualPhone.acceptedOf) emitted a frame of that
 * stop on the phone's replica, and the tower must have that stop's frame.
 * A route with seven on-the-way frames out of eight is a board with one dot
 * that never turned "a caminho".
 *
 * Pure, so it is tested without a server (tower-checks.test.ts); what the
 * tower heard comes from TowerObserver.routeEventsOf.
 */

/** One line of the end-of-day checks, as delivery-day.ts prints them. */
interface DayCheck {
  check: string;
  ok: boolean;
  detail: string;
}

/** What the tower's socket received about one route. */
interface TowerRouteEvents {
  /** routeEvent type → frames received. */
  counts: ReadonlyMap<string, number>;

  /**
   * stopId → the stopStatus of each `route-stop.settled` frame of that stop,
   * in arrival order (the arrival's ARRIVED, then how the stop ended).
   */
  settled: ReadonlyMap<string, readonly string[]>;

  /** The stopIds of the `route-stop.on_the_way` frames. */
  onTheWay: ReadonlySet<string>;
}

/** The stops whose call the API accepted from the phone (answered 2xx). */
interface AcceptedStops {
  /** "Estou a caminho": each one emits `route-stop.on_the_way`. */
  onTheWay: readonly string[];

  /** The arrival: each one emits `route-stop.settled` ARRIVED. */
  arrived: readonly string[];
}

interface TowerRouteExpectation {
  /** The fixture's code (R-PER). */
  route: string;
  towerReplica: string;
  phoneReplica: string;

  /** The route's stops at the end of the day, as the API reads them back. */
  stops: ReadonlyArray<{ id: string; status: string }>;

  /** What the phone sent about this route's stops and the API accepted. */
  accepted: AcceptedStops;

  /**
   * K11: the dispatcher closed the route with pending stops. The stops it
   * cancels get no stop frame — the closure's own `route.completed` is what
   * the boards hear (close-route-with-pending-usecase.ts).
   */
  closedWithPending: boolean;

  /** K12: the dispatcher added a stop while the route was on the street. */
  planChanged: boolean;
}

/** A stop that ended: the status its last settled frame must carry. */
const ENDED = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

function towerRouteCheck(
  expected: TowerRouteExpectation,
  seen: TowerRouteEvents,
): DayCheck {
  const count = (type: string) => seen.counts.get(type) ?? 0;
  const closure = expected.closedWithPending ? " (encerramento K11)" : "";

  const settledAs = (stopId: string, status: string) =>
    (seen.settled.get(stopId) ?? []).includes(status);

  const due = expected.stops.filter(
    (stop) =>
      ENDED.has(stop.status) &&
      !(stop.status === "CANCELLED" && expected.closedWithPending),
  );
  const unmatched = due.filter((stop) => !settledAs(stop.id, stop.status));

  const headedTo = [...new Set(expected.accepted.onTheWay)];
  const notOnTheWay = headedTo.filter((stopId) => !seen.onTheWay.has(stopId));

  const arrived = [...new Set(expected.accepted.arrived)];
  const notArrived = arrived.filter((stopId) => !settledAs(stopId, "ARRIVED"));

  const missing: string[] = [];

  if (count("route.started") === 0) missing.push("route.started");

  // No accepted "a caminho" on a route that ran on the other replica: the
  // per-stop requirement would be empty and pass without proving anything.
  if (headedTo.length === 0) {
    missing.push(
      "route-stop.on_the_way (nenhum a caminho aceito pelo telefone)",
    );
  } else if (notOnTheWay.length > 0) {
    missing.push(`route-stop.on_the_way de ${notOnTheWay.join(", ")}`);
  }

  // How each stop ended first, then the arrivals the tower never saw.
  const settledGaps = [
    ...unmatched.map((stop) => `${stop.id} ${stop.status}`),
    ...notArrived.map((stopId) => `${stopId} ARRIVED`),
  ];

  if (settledGaps.length > 0) {
    missing.push(`route-stop.settled de ${settledGaps.join(", ")}`);
  }
  if (count("route.completed") === 0) {
    missing.push(`route.completed${closure}`);
  }
  if (expected.planChanged && count("route.stops_changed") === 0) {
    missing.push("route.stops_changed (K12)");
  }

  const received = [
    `route.started ${count("route.started")}`,
    `route-stop.on_the_way ${headedTo.length - notOnTheWay.length}/${headedTo.length} paradas (${count("route-stop.on_the_way")} quadros)`,
    `route-stop.settled ${due.length - unmatched.length}/${due.length} paradas, ${arrived.length - notArrived.length}/${arrived.length} chegadas (${count("route-stop.settled")} quadros)`,
    `route.completed ${count("route.completed")}${closure}`,
    ...(expected.planChanged
      ? [`route.stops_changed ${count("route.stops_changed")} (K12)`]
      : []),
  ].join(", ");

  return {
    check: `${expected.route}: eventos da rota chegaram à torre na réplica ${expected.towerReplica} (via ${expected.phoneReplica})`,
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? received
        : `faltou ${missing.join("; ")} — recebidos: ${received}`,
  };
}

export { towerRouteCheck };
export type {
  AcceptedStops,
  DayCheck,
  TowerRouteEvents,
  TowerRouteExpectation,
};
