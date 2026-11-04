import { AppError } from "@/shared/errors/AppError";

import {
  openRoutesRefusal,
  type DriverLockout,
  type OpenRouteCounts,
} from "../../driver-rules";

/**
 * Deactivating a driver who still has work (decision 8.3). An inactive driver
 * cannot sign in, so a route in progress would lose its driver mid-way — the
 * app is logged out and its stops stay IN_TRANSIT — and a planned or released
 * route would wait for someone who can no longer start it.
 *
 * Revoking the driver's login and deactivating their branch lock the app out
 * the same way (K10, decision D31): same code, same counts, the sentence
 * naming the act.
 */
class DriverHasOpenRoutesError extends AppError {
  readonly openRoutes: OpenRouteCounts;

  constructor(
    openRoutes: OpenRouteCounts,
    act: DriverLockout = "DEACTIVATE_DRIVER",
  ) {
    super(openRoutesRefusal(openRoutes, act), 409, "DRIVER_HAS_OPEN_ROUTES");

    this.openRoutes = openRoutes;
  }
}

export { DriverHasOpenRoutesError };
