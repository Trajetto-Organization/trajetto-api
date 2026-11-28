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
const ROUTE_STATUSES_HANDING_OVER_VEHICLE = [
  "RELEASED",
  "IN_PROGRESS",
] as const;

type HandingOverRouteStatus =
  (typeof ROUTE_STATUSES_HANDING_OVER_VEHICLE)[number];

/**
 * How long an ended route waits in the driver's list for its arrival
 * checklist (C4, decision D08). The route closes itself when its last stop
 * resolves, so it has no open stop left; the app still has to ask for that
 * checklist. A day covers the drive back to the base and a phone that only
 * reconnects there; past it the web keeps the "checklist de chegada
 * pendente" flag and the driver's list moves on.
 *
 * The same window lets the driver of that ended route READ its vehicle
 * (canDriverReadVehicle): the checklist screen fills mileage and branch
 * from GET /vehicle/get-vehicle, asked exactly when the route is COMPLETED.
 */
const ENDED_ROUTE_CHECKLIST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A route as far as vehicle custody is concerned. */
interface VehicleAssignment {
  vehicleId?: string | null;
  driverId: string;
  status: string;
  /** Only read for a COMPLETED route (the arrival checklist window). */
  completed_at?: Date | string | null;
}

function routeHandsOverVehicle(
  status: string,
): status is HandingOverRouteStatus {
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
 * Whether the driver may READ the vehicle (GET /vehicle/get-vehicle): every
 * vehicle they may operate, plus the vehicle of their own route that ended
 * within the arrival checklist window. The substitute who drove truck X got
 * 403 the moment his route closed itself on the last stop, which is when
 * the app reads X to fill the arrival checklist the create accepts. Read
 * only: fuel, checklist without a route, the list and the histories keep
 * canDriverOperateVehicle.
 */
function canDriverReadVehicle(
  vehicle: { id: string; driverId?: string | null },
  driverId: string,
  routes: ReadonlyArray<VehicleAssignment>,
  now: Date,
): boolean {
  if (canDriverOperateVehicle(vehicle, driverId, routes)) return true;
  if (!driverId) return false;

  const windowStart = now.getTime() - ENDED_ROUTE_CHECKLIST_WINDOW_MS;

  return routes.some(
    (route) =>
      route.vehicleId === vehicle.id &&
      route.driverId === driverId &&
      route.status === "COMPLETED" &&
      route.completed_at != null &&
      new Date(route.completed_at).getTime() >= windowStart,
  );
}

/**
 * The same rule as a Prisma `where` on Vehicle, so a list of "my vehicles"
 * and the single-vehicle check can never disagree.
 */
function driverOperableVehicleWhere(
  driverId: string,
): Prisma.VehicleWhereInput {
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

/** canDriverReadVehicle as a Prisma `where` on Vehicle. */
function driverReadableVehicleWhere(
  driverId: string,
  now: Date,
): Prisma.VehicleWhereInput {
  return {
    OR: [
      ...(driverOperableVehicleWhere(driverId)
        .OR as Prisma.VehicleWhereInput[]),
      {
        routes: {
          some: {
            driverId,
            status: "COMPLETED",
            completed_at: {
              gte: new Date(now.getTime() - ENDED_ROUTE_CHECKLIST_WINDOW_MS),
            },
          },
        },
      },
    ],
  };
}

export {
  ENDED_ROUTE_CHECKLIST_WINDOW_MS,
  ROUTE_STATUSES_HANDING_OVER_VEHICLE,
  canDriverOperateVehicle,
  canDriverReadVehicle,
  driverOperableVehicleWhere,
  driverReadableVehicleWhere,
  routeHandsOverVehicle,
};
export type { VehicleAssignment };
