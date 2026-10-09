import type { Prisma } from "@prisma/client";

/**
 * Which vehicles a driver may operate from the app: fuel it, inspect it, see
 * it and its history (FLEET-ASSIGN-1, decisions 4.4 and 8.2).
 *
 * Two facts name the driver of a vehicle and both are true at once:
 * `Vehicle.driverId` is the fixed responsible driver (custody), and a route
 * with `driverId` + `vehicleId` is the day's assignment. Only the first used
 * to authorise the app, so the substitute a dispatcher assigned to truck X
 * drove X out of the yard and then got "Este veículo não está atribuído a
 * você" on the fuel form, and X was missing from his vehicle list.
 *
 * A route hands the vehicle over while it is RELEASED (the driver can see it
 * and do the pre-trip checklist) or IN_PROGRESS. PLANNED is still a draft the
 * dispatcher may change; COMPLETED and CANCELLED hand it back.
 */
const ROUTE_STATUSES_HANDING_OVER_VEHICLE = ["RELEASED", "IN_PROGRESS"] as const;

type HandingOverRouteStatus = (typeof ROUTE_STATUSES_HANDING_OVER_VEHICLE)[number];

/** A route as far as vehicle custody is concerned. */
interface VehicleAssignment {
  vehicleId?: string | null;
  driverId: string;
  status: string;
}

function routeHandsOverVehicle(status: string): status is HandingOverRouteStatus {
  return (ROUTE_STATUSES_HANDING_OVER_VEHICLE as readonly string[]).includes(
    status,
  );
}

/**
 * The rule itself, over facts already loaded: the responsible driver, or a
 * driver with a released or running route on this vehicle.
 */
function canDriverOperateVehicle(
  vehicle: { id: string; driverId?: string | null },
  driverId: string,
  routes: ReadonlyArray<VehicleAssignment>,
): boolean {
  if (!driverId) return false;
  if (vehicle.driverId === driverId) return true;

  return routes.some(
    (route) =>
      route.vehicleId === vehicle.id &&
      route.driverId === driverId &&
      routeHandsOverVehicle(route.status),
  );
}

/**
 * The same rule as a Prisma `where` on Vehicle, so a list of "my vehicles"
 * and the single-vehicle check can never disagree.
 */
function driverOperableVehicleWhere(driverId: string): Prisma.VehicleWhereInput {
  return {
    OR: [
      { driverId },
      {
        routes: {
          some: {
            driverId,
            status: { in: [...ROUTE_STATUSES_HANDING_OVER_VEHICLE] },
          },
        },
      },
    ],
  };
}

export {
  ROUTE_STATUSES_HANDING_OVER_VEHICLE,
  canDriverOperateVehicle,
  driverOperableVehicleWhere,
  routeHandsOverVehicle,
};
export type { VehicleAssignment };
