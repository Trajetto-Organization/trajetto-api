import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import type { LostStop } from "@/modules/route/dtos/route-dto";

/**
 * A proof the driver made without signal that reaches the server after the
 * delivery left their hands (K7, decision D27): the dispatcher cancelled the
 * route, or moved the delivery's status on the panel, in the meantime.
 *
 * It used to be refused — 404 (no longer the driver's) or 400 (a status that
 * cannot become DELIVERED) — which the app files as a permanent failure, and
 * the receipt photo and the signature were lost with it. Now, for the driver
 * of the route the delivery was taken from:
 *
 *  - tapped BEFORE it was taken, and the delivery can still take the proof
 *    (pending or failed, not in another driver's hands, and not planned on
 *    another route since): accepted as Entregue, flagged on the trail, with
 *    the audit card and a ticket for the tower;
 *  - otherwise (tapped after, a cancelled delivery, one another driver now
 *    carries, one the dispatcher already put on another route, or a type
 *    that waits for the tower): kept as evidence with no effect (the
 *    occurrence, SUPERSEDED, with its photos), flagged, and a ticket for the
 *    tower to decide.
 *
 * A delivery planned again has an open stop on its new route, and a proof
 * settles only the stop of a running route: applied, it would leave that
 * stop open on a delivered delivery, which nobody could ever resolve — the
 * new route would never close. That one is the tower's call.
 */

/** APPLIED: accepted as Entregue. EVIDENCE: kept with no effect. */
type LateProof = "APPLIED" | "EVIDENCE";

function lateProofVerdict(input: {
  occurredAt: Date | null | undefined;
  lostAt: Date;
  deliveryStatus: DeliveryStatus;
  deliveryDriverId: string | null | undefined;
  driverId: string;
  /** The type waits for the tower: a late proof never applies by itself. */
  asksTheTower: boolean;
  /**
   * The delivery has an open stop again (the dispatcher planned it on
   * another route after the loss). Absent reads as no.
   */
  onAnotherRoute?: boolean;
}): LateProof {
  const tappedBefore =
    input.occurredAt instanceof Date &&
    input.occurredAt.getTime() < input.lostAt.getTime();

  const stillProvable =
    (input.deliveryStatus === "PENDING" || input.deliveryStatus === "FAILED") &&
    (!input.deliveryDriverId || input.deliveryDriverId === input.driverId) &&
    input.onAnotherRoute !== true;

  return tappedBefore && stillProvable && !input.asksTheTower
    ? "APPLIED"
    : "EVIDENCE";
}

/** The trail's flag, in the tower's words. */
function lateProofNote(verdict: LateProof, lost: LostStop): string {
  const cancelled =
    lost.routeStatus === "CANCELLED" && lost.stopStatus === "CANCELLED";
  // "Encerrar com pendências" (K11): the route ended COMPLETED and called
  // its open stops off — nobody changed the delivery's status.
  const closedWithPending =
    lost.routeStatus === "COMPLETED" && lost.stopStatus === "CANCELLED";

  // "após o / depois do" cancelamento; "após a / depois da" mudança.
  const [after, since] = cancelled
    ? [
        `após o cancelamento da Rota ${lost.routeCode}`,
        `depois do cancelamento da Rota ${lost.routeCode}`,
      ]
    : closedWithPending
      ? [
          `após o encerramento da Rota ${lost.routeCode} com pendências`,
          `depois do encerramento da Rota ${lost.routeCode} com pendências`,
        ]
      : [
          "após a mudança de status da entrega",
          "depois da mudança de status da entrega",
        ];

  return verdict === "APPLIED"
    ? `Comprovante ${after}: o motorista comprovou sem sinal antes disso, ` +
        "e a entrega foi aceita como Entregue. Confira o registro."
    : `Comprovante recebido ${since}: guardado como evidência, ` +
        "sem efeito no status. A torre decide.";
}

export { lateProofNote, lateProofVerdict };
export type { LateProof };
