import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";

/**
 * Whether a request for the tower's authorization still has something to
 * authorize (decision 6.3).
 *
 * A request is about ONE attempt of a delivery: the driver who holds it, on
 * the stop it occupies. It stops being answerable the moment that attempt is
 * over, whoever ended it — a proof, a panel status change, a cancellation, a
 * route cancelled, the load returned to base, the delivery moved to another
 * route or driver. Stated once, here, as a rule over what the delivery IS
 * now, rather than as a duty of every writer that moves a delivery: a writer
 * added tomorrow cannot forget it. The queue, the escalation sweep and the
 * decision all ask this rule (the Prisma repository says it in SQL, the twin
 * through this function), and the sweep closes what fails it as SUPERSEDED.
 *
 * Monotonic on purpose — once an attempt is over it never comes back: a new
 * stop is a new attempt even on the same route (the stop's created_at), and a
 * panel status change is final for the request even when the status returns.
 * So the sweep, the queue and the decision agree whatever the timing.
 */

/** The statuses an attempt is still running in. FAILED ended it. */
const ACTIVE_ATTEMPT_STATUSES: readonly DeliveryStatus[] = ["PENDING", "IN_TRANSIT"];

/** What the request recorded about its attempt when it was filed. */
interface AuthorizationAnchor {
  /**
   * The reporter's driver link. A driver's request lives while that driver
   * still holds the delivery; a request filed from the panel (null) is not
   * tied to a driver.
   */
  reporterDriverId: string | null;
  /** The route of the open stop when it was filed (its OCCURRENCE event). */
  routeId: string | null;
  created_at: Date;
}

/** The delivery as it is now. */
interface AttemptState {
  status: DeliveryStatus;
  driverId: string | null;
  /** The delivery's open stop (PENDING or ARRIVED), at most one. */
  openStop: { routeId: string; created_at: Date } | null;
  /** A STATUS_CHANGE event (the panel) written after the request. */
  statusChangedSince: boolean;
}

function isActiveAttemptStatus(status: DeliveryStatus): boolean {
  return ACTIVE_ATTEMPT_STATUSES.includes(status);
}

function authorizationRequestIsLive(
  anchor: AuthorizationAnchor,
  state: AttemptState,
): boolean {
  if (!isActiveAttemptStatus(state.status)) return false;

  if (state.statusChangedSince) return false;

  if (anchor.reporterDriverId !== null && state.driverId !== anchor.reporterDriverId) {
    return false;
  }

  if (!state.openStop) return anchor.routeId === null;

  return (
    state.openStop.routeId === anchor.routeId &&
    state.openStop.created_at.getTime() <= anchor.created_at.getTime()
  );
}

export { authorizationRequestIsLive, isActiveAttemptStatus };
export type { AttemptState, AuthorizationAnchor };
