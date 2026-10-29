import { Prisma } from "@prisma/client";

import {
  VehicleChecklist,
  CreateVehicleChecklistProps,
  ListVehicleChecklistProps,
  ListVehicleChecklistByBusinessIdProps,
  UpdateVehicleChecklist,
  GetVehicleChecklistByIdAndBusinessProps,
} from "../dtos/vehicle-checklist-dto";
import type { ChecklistListFilters } from "../usecases/list-vehicle-checklist/checklist-list";

interface ChecklistMileageUpdate {
  businessId: string;
  vehicleId: string;
  currentMileage: number;

  /** The checklist's date, where its reading sits on the odometer's timeline. */
  at: Date;

  /** The checklist being edited, never its own neighbour. */
  checklistId?: string;

  /**
   * The company's zone (Business.timezone): which readings fall on a later
   * civil day. The default zone when absent.
   */
  timeZone?: string | null;

  /**
   * The reading or the vehicle changed (the default): the odometer may
   * follow the placement. False when only the date moved: the reading must
   * still be in order at the new date, and the odometer does not move.
   */
  readingChanged?: boolean;
}

/** Where a new checklist's reading is placed on its vehicle's timeline. */
interface ChecklistPlacement {
  /**
   * The company's zone (Business.timezone): which readings fall on a later
   * civil day. The default zone when absent.
   */
  timeZone?: string | null;
}

interface IVehicleChecklistRepository {
  createVehicleChecklist: (
    checklistData: CreateVehicleChecklistProps,
  ) => Promise<VehicleChecklist>;
  /**
   * The checklist and, when it is the newest reading, the vehicle's odometer,
   * in one transaction. Placed by its date first (placeReading, the fueling
   * create's rule): between the readings around it the vehicle stays; above a
   * reading of a later civil day it is refused (VehicleMileageInvalidError).
   */
  createVehicleChecklistWithMileage: (
    checklistData: CreateVehicleChecklistProps,
    afterCreate?: (
      tx: Prisma.TransactionClient,
      checklist: VehicleChecklist,
    ) => Promise<void>,
    placement?: ChecklistPlacement,
  ) => Promise<{ checklist: VehicleChecklist; created: boolean }>;
  findBySubmissionId: (
    businessId: string,
    clientSubmissionId: string,
  ) => Promise<VehicleChecklist | null>;
  /** One company's page, sorted and filtered by the server, with its counts. */
  listVehicleChecklists: (
    listChecklistProps: ListVehicleChecklistByBusinessIdProps,
  ) => Promise<ListVehicleChecklistProps>;
  updateVehicleChecklist: ({
    checklistData,
    checklistId,
  }: UpdateVehicleChecklist) => Promise<VehicleChecklist>;
  /**
   * The edit and, when its reading, vehicle or date changes, the odometer,
   * in one transaction: placed at `at` by placeReading (the fueling edit's
   * rule) over shared/vehicle/odometerTimeline, the checklist itself left
   * out. Between later and earlier readings the vehicle is left alone; as the
   * newest reading the odometer follows it. Moved to another vehicle, the one
   * it leaves gets its odometer back from the readings left (releaseOdometer).
   */
  updateVehicleChecklistAndMileage: (
    update: UpdateVehicleChecklist,
    mileageUpdate?: ChecklistMileageUpdate,
  ) => Promise<VehicleChecklist>;
  /**
   * Deletes the row and, when its reading set the vehicle's odometer, gives
   * the odometer back to the highest reading left (releaseOdometer).
   */
  deleteVehicleChecklist: (checklistId: string) => Promise<VehicleChecklist>;
  findVehicleChecklistById: (
    checklistId: string,
  ) => Promise<VehicleChecklist | null>;
  getVehicleChecklistByIdAndBusiness({
    businessId,
    checklistId,
  }: GetVehicleChecklistByIdAndBusinessProps): Promise<VehicleChecklist | null>;
  /** The driver-deletion guard counts, it does not load (FLEET-VEH-10). */
  countVehicleChecklistsByDriverId: (driverId: string) => Promise<number>;
  /** The listing's rows (same filters), for the export (decision 5.8). */
  streamChecklistsForExport(
    filters: ChecklistListFilters,
  ): AsyncGenerator<Record<string, unknown>>;
  countChecklistForExport: (filters: ChecklistListFilters) => Promise<number>;
}

export { IVehicleChecklistRepository };
export type { ChecklistMileageUpdate, ChecklistPlacement };
