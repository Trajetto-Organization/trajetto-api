import { sendCatalogChangedEvent } from "@/websocket";

import { routeMovesVehicle, type VehicleRoute } from "./route-vehicle";

/**
 * The vehicle catalogue's hint (`catalogChanged` vehicle), for the writes
 * that change a vehicle without being a vehicle write (audit of 25/11/2026).
 *
 * The web trusts its vehicle lists (the VehicleSelector, "Meus veículos")
 * for two minutes, and the app its own, on the promise that this hint keeps
 * them current. Only the vehicle's create, edit and delete sent it, so the
 * truck that left kept no "Em rota" badge, the one that came back kept it,
 * and the odometer and the last maintenance stayed behind after a
 * refuelling, a checklist or a service order made elsewhere, until a
 * reload. Each write that moves what those lists show calls this once,
 * after its commit — never inside the transaction, so a write that rolled
 * back tells nobody — however many of the company's vehicles it touched.
 *
 * tests/unitaires/quality/vehicle-catalog-hints.test.ts lists every write
 * on the vehicle table and the use cases that reach it, and fails when one
 * of them does not come through here.
 */
function announceVehicleChanged(businessId: string): void {
  sendCatalogChangedEvent(businessId, "vehicle");
}

/**
 * After a route's departure or end committed: the vehicle catalogue's hint
 * when that write moved the truck. A vehicle an administrator blocked while
 * it was out stays blocked (the conditional write matched nothing) and is
 * announced all the same: a hint costs a refetch, a missing one a stale
 * badge.
 */
function announceRouteVehicle(businessId: string, route: VehicleRoute): void {
  if (routeMovesVehicle(route)) announceVehicleChanged(businessId);
}

export { announceRouteVehicle, announceVehicleChanged };
