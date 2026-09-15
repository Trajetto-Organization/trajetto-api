import { surfaces } from "./lib/api.js";

/**
 * One virtual user, one pass over every surface.
 *
 * Not a load test: it is the test that proves the load tests are measuring
 * something real. A stress run against a URL that 404s reports a beautiful
 * p95, and that is the single most common way a load suite lies.
 */
export const options = {
  vus: 1,
  iterations: 1,

  thresholds: {
    // Zero. A smoke run with a failure means every number after it is noise.
    surface_failures: ["rate==0"],
  },
};

export default function smoke() {
  surfaces.health();

  surfaces.listDeliveries();
  surfaces.getDelivery();

  surfaces.listRoutes();
  surfaces.operationSummary();
  surfaces.controlTower();

  surfaces.myDeliveries(0);
  surfaces.recordPositions(0);

  surfaces.integrationDeliveries();
  surfaces.catalogue();

  surfaces.unreadCount();
  surfaces.dashboardOverview();
}
