import { AppError } from "@/shared/errors/AppError";

import { openRoutesRefusal, type OpenRouteCounts } from "../../driver-rules";

/**
 * Deactivating a driver who still has work (decision 8.3). An inactive driver
 * cannot sign in, so a route in progress would lose its driver mid-way — the
 * app is logged out and its stops stay IN_TRANSIT — and a planned or released
 * route would wait for someone who can no longer start it.
 */
class DriverHasOpenRoutesError extends AppError {
  readonly openRoutes: OpenRouteCounts;

  constructor(openRoutes: OpenRouteCounts) {
    super(openRoutesRefusal(openRoutes), 409, "DRIVER_HAS_OPEN_ROUTES");

    this.openRoutes = openRoutes;
  }
}

export { DriverHasOpenRoutesError };
