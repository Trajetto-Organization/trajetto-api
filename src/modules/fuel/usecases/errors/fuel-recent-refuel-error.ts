import { AppError } from "@/shared/errors/AppError";

import { recentRefuelMessage, type RefuelNearby } from "../fuel-rules";

/** The other refuelling, as the refusal's body names it (`previous_refuel`). */
interface PreviousRefuel {
  id: string;
  /** ISO 8601. */
  refueling_date: string;
  liters_amount: number;
  current_mileage: number;
}

/**
 * A driver's second refuelling of the vehicle within 30 minutes of another,
 * sent unconfirmed by a build that asks (fuel-rules.ts asksAboutRecentRefuel).
 * 409, like the other refusals the app's outbox files on the merits; the
 * other refuelling rides along so the app can show it in the question
 * (the fuel error table sends it as `previous_refuel`). The app decides on
 * the code and resends the same body, key and photo with `confirm_recent`
 * and `recent_reason`: nothing was recorded and the photo was not touched.
 */
class FuelRecentRefuelError extends AppError {
  readonly previousRefuel: PreviousRefuel;

  constructor(previous: RefuelNearby, timeZone: string) {
    super(
      recentRefuelMessage(previous.refueling_date, timeZone),
      409,
      "FUEL_RECENT_REFUEL",
    );
    this.name = "FuelRecentRefuelError";
    this.previousRefuel = {
      id: previous.id,
      refueling_date: new Date(previous.refueling_date).toISOString(),
      liters_amount: Number(previous.liters_amount),
      current_mileage: previous.current_mileage,
    };
  }
}

export { FuelRecentRefuelError };
export type { PreviousRefuel };
