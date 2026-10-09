import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";

import { AppError } from "@/shared/errors/AppError";
import { businessToday, dateOnlyKey } from "@/shared/time/business-day";

import {
  assignmentWarnings,
  type AssignmentWarning,
} from "./assignment-warnings";

import type {
  AssignmentPreview,
  AssignmentVehicleRef,
} from "../../dtos/route-dto";

interface AssignmentPreviewRequest {
  userId: string;
  businessId: string;
  driverId: string;
  vehicleId?: string | null;

  /** The route's day; today in the company's zone when absent. */
  scheduled_date?: Date;

  /** The route being edited, whose own rows are not a conflict. */
  excludeRouteId?: string | null;

  /** The batch assignment's selection (routes it empties are no conflict). */
  deliveryIds?: string[];
}

interface AssignmentPreviewResult {
  /** "YYYY-MM-DD" the warnings were computed for. */
  scheduled_date: string;

  /**
   * The company's zone (Business.timezone, resolved). The forms judge "the
   * departure is on the route's day" in it, as the API does, instead of in
   * the browser's zone, which differs for a MASTER working from elsewhere.
   */
  timeZone: string;

  /** Only what the choice needs (decision 4.7): no CNH data leaves here. */
  driver: { id: string; name: string; status: string };

  /** Vehicles in operation this driver is responsible for. */
  responsibleVehicles: AssignmentVehicleRef[];

  /**
   * The vehicle to preselect: the driver's only responsible vehicle. Null
   * when there is none or more than one — guessing between two would be a
   * choice the dispatcher did not make.
   */
  suggestedVehicleId: string | null;

  vehicle:
    | (AssignmentVehicleRef & {
        responsible: { id: string; name: string } | null;
      })
    | null;

  warnings: AssignmentWarning[];
}

/**
 * What the "Atribuir Motorista e Veículo" and "Planejar rota" dialogs show
 * about a driver/vehicle pair before it is confirmed (FLEET-ASSIGN-2): the
 * vehicle the driver is responsible for, who is responsible for the chosen
 * vehicle, and the routes either one already has running or on that day.
 *
 * A dispatcher's read, like the plan it serves: a driver's token is refused
 * the same way every planning write refuses it. The company comes from the
 * path and the tenant hook; a driver or vehicle id of another company reads
 * as absent (404), never as "exists elsewhere".
 */
@injectable()
class AssignmentPreviewUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
  ) {}

  async execute({
    userId,
    businessId,
    driverId,
    vehicleId,
    scheduled_date,
    excludeRouteId,
    deliveryIds,
  }: AssignmentPreviewRequest): Promise<AssignmentPreviewResult> {
    await assertRouteDispatcher(this.user, userId, businessId);

    const { timeZone, fleetEnabled } =
      await this.route.assignmentContext(businessId);

    const day = scheduled_date ?? businessToday(timeZone);

    const preview = await this.route.assignmentPreview({
      businessId,
      driverId,
      vehicleId: vehicleId ?? null,
      day,
      deliveryIds,
      // Open orders and checklists are FLEET's records: a company without
      // the module is not warned about them (decision 4.3), as fleet-maint's
      // own endpoint for this warning answers MODULE_NOT_ENABLED.
      fleetFacts: fleetEnabled,
    });

    if (!preview.driver) {
      throw new AppError("Motorista não encontrado.", 404, "DRIVER_NOT_FOUND");
    }

    if (vehicleId && !preview.vehicle) {
      throw new AppError("Veículo não encontrado.", 404, "VEHICLE_NOT_FOUND");
    }

    const { responsibleVehicles } = preview;

    return {
      scheduled_date: dateOnlyKey(day),
      timeZone,
      driver: {
        id: preview.driver.id,
        name: preview.driver.name,
        status: preview.driver.status,
      },
      responsibleVehicles,
      suggestedVehicleId:
        responsibleVehicles.length === 1 ? responsibleVehicles[0].id : null,
      vehicle: preview.vehicle
        ? {
            id: preview.vehicle.id,
            license_plate: preview.vehicle.license_plate,
            description: preview.vehicle.description,
            status: preview.vehicle.status,
            responsible: preview.vehicle.responsible,
          }
        : null,
      warnings: assignmentWarnings(preview, {
        driverId,
        excludeRouteId,
        day,
        timeZone,
      }),
    };
  }
}

export { AssignmentPreviewUseCase };
export type { AssignmentPreviewRequest, AssignmentPreviewResult };
