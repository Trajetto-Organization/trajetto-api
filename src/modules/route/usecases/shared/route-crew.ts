import { AppError } from "@/shared/errors/AppError";
import {
  isVehicleOutOfOperation,
  type OutOfOperationStatus,
  type VehicleStatus,
} from "@/shared/vehicle/vehicle-rules";

import {
  RouteDriverInactiveError,
  RouteVehicleUnavailableError,
} from "../errors/route-errors";

/**
 * What keeps a driver or a vehicle off a new route: the one rule for every
 * writer that puts a crew on a route — the Rotas screen (create, edit), the
 * batch assignment (through create) and the spreadsheet import, which used
 * to build its routes without asking and planned routes for an inactive
 * driver on a blocked truck.
 *
 * Only the states. Whether the records are the company's is each caller's
 * lookup (a 404 there), and the departure asks about the vehicle again.
 */
type CrewIssue =
  | { code: "ROUTE_DRIVER_INACTIVE"; message: string }
  | {
      code: "ROUTE_VEHICLE_UNAVAILABLE";
      plate: string;
      status: OutOfOperationStatus;
      message: string;
    };

interface CrewCandidate {
  /** Null or absent: the driver is not part of this check. */
  driver?: { status: string } | null;

  /** Null or absent: no vehicle, or not part of this check. */
  vehicle?: { status: VehicleStatus; license_plate: string } | null;
}

/** Every issue of the crew, the driver's first. Empty: it may take the route. */
function crewIssues({ driver, vehicle }: CrewCandidate): CrewIssue[] {
  const issues: CrewIssue[] = [];

  if (driver && driver.status !== "ACTIVE") {
    issues.push({
      code: "ROUTE_DRIVER_INACTIVE",
      message: new RouteDriverInactiveError().message,
    });
  }

  // IN_ROUTE is not an issue: tomorrow's route is planned while today's is
  // on the street. What is refused is the second DEPARTURE, in the database.
  if (vehicle && isVehicleOutOfOperation(vehicle.status)) {
    issues.push({
      code: "ROUTE_VEHICLE_UNAVAILABLE",
      plate: vehicle.license_plate,
      status: vehicle.status,
      message: new RouteVehicleUnavailableError(
        vehicle.license_plate,
        vehicle.status,
      ).message,
    });
  }

  return issues;
}

/** The panel's answer: the first issue as a 400 with its code. */
function assertCrewFit(candidate: CrewCandidate): void {
  const [issue] = crewIssues(candidate);

  if (issue) throw new AppError(issue.message, 400, issue.code);
}

export { assertCrewFit, crewIssues };
export type { CrewCandidate, CrewIssue };
