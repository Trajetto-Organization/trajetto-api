import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";

/**
 * What POST /integration/v1/deliveries/:id/cancel does with a delivery, by
 * its status (plan of 02/11/2026, L9; decision D49).
 *
 * - CANCEL: Pendente (on no route, or on one that has not left) and
 *   Insucesso. Both are a delivery nobody is carrying, which an ERP whose
 *   order was called off can stop on its own.
 * - REPLAY: already Cancelada, by this key, another one or the panel. Nothing
 *   is written and nothing is announced: repeating a cancel is safe without
 *   an Idempotency-Key, because the state itself says it was done.
 * - REFUSE: Entregue is final, and Em rota is a load on a truck. Bringing it
 *   back is the carrier's call, made by a person on the panel (owner's
 *   decision). Opening it later is moving IN_TRANSIT to CANCEL: the panel's
 *   path below already settles the running stop and tells the driver.
 *
 * A Record over every status, so a status added to the enum does not compile
 * until somebody decides what the API does with it.
 */
type IntegrationCancelVerdict = "CANCEL" | "REPLAY" | "REFUSE";

const INTEGRATION_CANCEL_VERDICTS = {
  PENDING: "CANCEL",
  FAILED: "CANCEL",
  CANCELLED: "REPLAY",
  IN_TRANSIT: "REFUSE",
  DELIVERED: "REFUSE",
} as const satisfies Record<DeliveryStatus, IntegrationCancelVerdict>;

/** The statuses the API refuses to cancel, each with its own sentence. */
type NotCancellableStatus = {
  [
    S in DeliveryStatus
  ]: (typeof INTEGRATION_CANCEL_VERDICTS)[S] extends "REFUSE" ? S : never;
}[DeliveryStatus];

function integrationCancelVerdict(
  status: DeliveryStatus,
): IntegrationCancelVerdict {
  return INTEGRATION_CANCEL_VERDICTS[status];
}

function isNotCancellable(
  status: DeliveryStatus,
): status is NotCancellableStatus {
  return integrationCancelVerdict(status) === "REFUSE";
}

/**
 * The refused statuses, in the table's order: the values the 409's
 * `delivery_status` can take. The published enum is this list, so opening
 * a status (or refusing a new one) changes the document with the table.
 */
const NOT_CANCELLABLE_STATUSES = (
  Object.keys(INTEGRATION_CANCEL_VERDICTS) as DeliveryStatus[]
).filter(isNotCancellable) as [NotCancellableStatus, ...NotCancellableStatus[]];

/**
 * The reason's bounds: a word at least (the panel's reason is a catalogue
 * entry, never empty), and the panel annotation's 500 at most.
 */
const CANCEL_REASON_MIN = 3;
const CANCEL_REASON_MAX = 500;

export {
  CANCEL_REASON_MAX,
  CANCEL_REASON_MIN,
  INTEGRATION_CANCEL_VERDICTS,
  integrationCancelVerdict,
  isNotCancellable,
  NOT_CANCELLABLE_STATUSES,
};
export type { IntegrationCancelVerdict, NotCancellableStatus };
