/**
 * Delivery status machine, kept pure so it can be unit-tested. Every status
 * write in the module must pass through canTransitionDelivery, with ONE
 * sanctioned exception: statusAfterOccurrence (below) moves an active delivery
 * to FAILED — PENDING included, which the table does not list — because a
 * blocking occurrence is the result of an attempt, not a manual move.
 */

type DeliveryStatus =
  | "PENDING"
  | "IN_TRANSIT"
  | "DELIVERED"
  | "FAILED"
  | "CANCELLED";

const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  PENDING: "Pendente",
  IN_TRANSIT: "Em rota",
  DELIVERED: "Entregue",
  FAILED: "Insucesso",
  CANCELLED: "Cancelada",
};

/**
 * IN_TRANSIT → PENDING covers the truck returning to base with the cargo
 * (reschedule), and takes the delivery off a running route (see
 * stopOutcomeForDelivery); FAILED → PENDING is the redelivery decision.
 * DELIVERED and CANCELLED are terminal — a proven or cancelled delivery never
 * moves again (audit trail). A proof registered by mistake is not undone;
 * the fact stays, and what follows is a new delivery.
 */
const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  PENDING: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["DELIVERED", "FAILED", "PENDING", "CANCELLED"],
  FAILED: ["PENDING", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

interface DeliveryTransitionVerdict {
  allowed: boolean;

  /** Present when blocked — the exact message the user should read. */
  reason: string | null;
}

function canTransitionDelivery(
  from: DeliveryStatus,
  to: DeliveryStatus,
): DeliveryTransitionVerdict {
  if (from === to) {
    return {
      allowed: false,
      reason: `A entrega já está com o status "${DELIVERY_STATUS_LABELS[from]}".`,
    };
  }

  if (DELIVERY_TRANSITIONS[from].includes(to)) {
    return { allowed: true, reason: null };
  }

  return {
    allowed: false,
    reason:
      `Não é possível mudar a entrega de "${DELIVERY_STATUS_LABELS[from]}" ` +
      `para "${DELIVERY_STATUS_LABELS[to]}".`,
  };
}

function isTerminalDeliveryStatus(status: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[status].length === 0;
}

/**
 * Whether the panel may edit the delivery's data: only while the cargo is
 * not moving and the outcome is not proven — pending, or failed and awaiting
 * a redelivery decision. Mirrored by the web's row menu.
 */
function isDeliveryEditable(status: DeliveryStatus): boolean {
  return status === "PENDING" || status === "FAILED";
}

/**
 * Occurrences never move terminal deliveries. A blocking occurrence type
 * flips an active delivery to FAILED (Comprovei semantics: impeditive
 * occurrence = unsuccessful attempt); informational types keep the status.
 *
 * This is the one writer allowed around DELIVERY_TRANSITIONS: PENDING →
 * FAILED is not in the table on purpose (nobody may pick it by hand), but an
 * attempt reported by the driver is an outcome, whatever the load's status.
 */
function statusAfterOccurrence(
  current: DeliveryStatus,
  blocksDelivery: boolean,
): DeliveryStatus {
  if (!blocksDelivery || isTerminalDeliveryStatus(current)) {
    return current;
  }

  return "FAILED";
}

export {
  canTransitionDelivery,
  isDeliveryEditable,
  isTerminalDeliveryStatus,
  statusAfterOccurrence,
  DELIVERY_STATUS_LABELS,
  DELIVERY_TRANSITIONS,
};
export type { DeliveryStatus, DeliveryTransitionVerdict };
