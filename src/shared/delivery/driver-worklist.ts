import type { DeliveryStatus } from "./delivery-rules";

/**
 * The statuses that put a delivery on a driver's phone.
 *
 * `listDriverDeliveries` serves exactly these two, so membership of this set
 * IS the driver's working list — anything else is invisible to them.
 */
const DRIVER_WORKLIST_STATUSES: DeliveryStatus[] = ["PENDING", "IN_TRANSIT"];

function isOnDriverWorklist(status: DeliveryStatus): boolean {
  return DRIVER_WORKLIST_STATUSES.includes(status);
}

/**
 * Whether a dispatcher's status override has to reach the driver's phone.
 *
 * The case this exists for: a delivery the driver has on their list is
 * cancelled from the panel at 10am, and the driver — whose app caches the day
 * for seven days offline — simply loses the row on the next sync. Nobody told
 * them anything. They drive to the address, or they notice one is missing and
 * cannot find out which.
 *
 * So the trigger is CROSSING the working list, in either direction:
 *
 *  - leaving it (cancelled, marked delivered or failed from the panel) means
 *    an address they must not drive to;
 *  - entering it (a failed delivery reopened as pending) means work they do
 *    not know they have, which is the same problem with the sign flipped.
 *
 * A move WITHIN the list — pending to in-transit, which the dispatcher does
 * when they mark a load as departed — changes nothing the driver can act on
 * and deliberately rings no phone. Thirty drivers times a notification for
 * every bookkeeping move is how a notification system stops being read.
 *
 * Pure, because whether somebody's phone rings is a product decision, and a
 * product decision that needs a database to test is one nobody tests.
 */
function driverShouldHearOverride(props: {
  from: DeliveryStatus;
  to: DeliveryStatus;

  /** Null when the delivery has nobody assigned — there is nobody to tell. */
  driverId: string | null | undefined;
}): boolean {
  if (!props.driverId) return false;
  if (props.from === props.to) return false;

  return isOnDriverWorklist(props.from) !== isOnDriverWorklist(props.to);
}

export {
  DRIVER_WORKLIST_STATUSES,
  driverShouldHearOverride,
  isOnDriverWorklist,
};
