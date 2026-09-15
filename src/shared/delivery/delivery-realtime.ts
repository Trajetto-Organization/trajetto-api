import { sendDeliveryEventToDriver } from "@/websocket";
import type { DeliveryStatus } from "./delivery-rules";

/**
 * What the driver's app hears about a delivery of theirs, live.
 *
 * Deliberately NOT through the outbox: the outbox exists for deliveries that
 * must survive a crash and be retried, and a socket frame's entire value is
 * being instant — a retried one would arrive after the client had already
 * refetched the truth. The push for the same event IS published through the
 * outbox, and the two are not redundant: one reaches a pocket, this reaches
 * an open screen.
 *
 * Always called AFTER the transaction commits.
 */
interface DeliveryRealtimeEvent {
  type: "delivery.status_overridden";

  deliveryId: string;
  status: DeliveryStatus;

  /** True when the stop left the driver's list — the urgent case. */
  removedFromWorklist: boolean;
}

function announceDeliveryOverride(
  driverUserId: string | null,
  event: DeliveryRealtimeEvent,
): void {
  // Null is ordinary, not an error: a delivery with no driver has nobody to
  // tell, and the caller already decided this one does.
  sendDeliveryEventToDriver(driverUserId, event);
}

export { announceDeliveryOverride };
export type { DeliveryRealtimeEvent };
