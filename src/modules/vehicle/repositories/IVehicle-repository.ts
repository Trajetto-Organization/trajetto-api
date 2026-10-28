import { Prisma } from "@prisma/client";

import {
  Vehicle,
  CreateVehicleProps,
  ListVehicleProps,
  ListVehicleByBusinessIdProps,
  UpdateVehicle,
  GetVehicleByIdAndBusinessProps,
  SearchVehicleWithCursorProps,
  CursorPaginatedVehicle,
  VehicleUsageCounts,
  VehicleStatusCounts,
} from "../dtos/vehicle-dto";

import type { VehicleListFilters } from "../usecases/list-vehicle/vehicle-list";
import type { OpenRouteCounts } from "@/shared/vehicle/vehicle-status-change";

interface IVehicleRepository {
  createVehicle: (vehicleData: CreateVehicleProps) => Promise<Vehicle>;

  /**
   * Creates within the contracted fleet: count and insert in the SAME
   * transaction, with the company locked. The limit is billing; a
   * count-then-create lets N concurrent requests all pass. `vehicle: null`
   * when the limit is reached, so the caller words the refusal.
   */
  createVehicleWithinLimit: (
    vehicleData: CreateVehicleProps,
    limit: { max: number; occupiesSlot: boolean },
  ) => Promise<{ vehicle: Vehicle | null; activeCount: number }>;

  /**
   * An update that puts an INACTIVE vehicle back into a contracted slot
   * (FLEET-VEH-7), under the same per-company lock as the create: counting
   * and writing apart let N simultaneous reactivations all pass the limit.
   * Returns `vehicle: null`, writing nothing, when the limit is reached.
   */
  updateVehicleWithinLimit: (
    update: UpdateVehicle & { businessId: string },
    limit: { max: number },
  ) => Promise<{ vehicle: Vehicle | null; activeCount: number }>;

  /** One page with its raw status and branch counts (decision 8.8). */
  listVehicles: (
    listVehicleProps: ListVehicleByBusinessIdProps,
  ) => Promise<ListVehicleProps>;

  /** With `tx`, inside the caller's transaction. */
  updateVehicle: (
    { vehicleData, vehicleId }: UpdateVehicle,
    tx?: Prisma.TransactionClient,
  ) => Promise<Vehicle>;

  /**
   * A finished service order moving the odometer — forward only (IDEMP-15).
   *
   * Moves current_mileage (and the last maintenance) to `mileage` only while
   * the row still holds less, in one statement, the way fuel and checklists
   * already do. The order validated against a read taken earlier; a
   * refuelling committed since with a higher reading would otherwise be
   * written over, and the counter — and every maintenance alert computed from
   * it — would run backwards. Returns false, writing nothing, when the row is
   * already at or past `mileage`.
   */
  advanceMileageAfterService: (
    props: {
      vehicleId: string;
      businessId: string;
      mileage: number;
      /** Absent when correcting an order that was already finished. */
      maintenanceDate?: Date | string | null;
    },
    tx?: Prisma.TransactionClient,
  ) => Promise<boolean>;

  deleteVehicle: (vehicleId: string) => Promise<Vehicle>;
  findVehicleById: (vehicleId: string) => Promise<Vehicle | null>;

  /**
   * Plate and RENAVAM are unique PER COMPANY (decision 8.1): a lookup without
   * the company found another carrier's truck, refused a legitimate
   * registration and told the caller that plate existed somewhere. The
   * company is required, so no caller can ask across tenants again.
   */
  findVehicleByLicensePlate: (
    licensePlate: string,
    businessId: string,
  ) => Promise<Vehicle | null>;
  findVehicleByRenavam: (
    renavam: string,
    businessId: string,
  ) => Promise<Vehicle | null>;

  getVehicleByIdAndBusiness({
    businessId,
    vehicleId,
  }: GetVehicleByIdAndBusinessProps): Promise<Vehicle | null>;
  findVehiclesByFuelTypeId: (fuelTypeId: string) => Promise<Vehicle[]>;

  /** The listing's rows (same filters), for the export (decision 5.8). */
  streamVehiclesForExport: (
    filters: VehicleListFilters,
  ) => AsyncGenerator<Record<string, unknown>>;
  countVehiclesForExport: (filters: VehicleListFilters) => Promise<number>;

  searchVehicleWithCursor: (
    props: SearchVehicleWithCursorProps,
  ) => Promise<CursorPaginatedVehicle>;

  /**
   * Whether this driver may operate this vehicle of this company: its
   * responsible driver, or on a released or running route with it
   * (FLEET-ASSIGN-1, shared/vehicle/driver-vehicle-access).
   */
  canDriverOperateVehicle: (props: {
    vehicleId: string;
    driverId: string;
    businessId: string;
  }) => Promise<boolean>;

  /** Routes of this vehicle still ahead or on the road (decision 8.3). */
  countOpenRoutesForVehicle: (
    vehicleId: string,
    businessId: string,
  ) => Promise<OpenRouteCounts>;

  /** What still references the vehicle, counted, not loaded (FLEET-VEH-10). */
  countVehicleUsage: (vehicleId: string) => Promise<VehicleUsageCounts>;

  /**
   * The company's whole fleet by status, in one grouped count: what the
   * plan's slots read (every status but INACTIVE occupies one, see
   * occupiesFleetSlot) and the card's breakdown, from the same rows.
   */
  countVehiclesByStatusForBusiness: (
    businessId: string,
  ) => Promise<VehicleStatusCounts>;
}

export { IVehicleRepository };
