import { Prisma } from "@prisma/client";

import {
  Fuel,
  CreateFuelProps,
  ListFuelProps,
  ListFuelByBusinessIdProps,
  UpdateFuel,
  GetFuelByIdAndBusinessProps,
  SearchFuelByVehicleWithCursorProps,
  CursorPaginatedFuel,
  RouteFuelSummary,
} from "../dtos/fuel-dto";

import type { FuelListFilters } from "../usecases/list-fuel/fuel-list";
import type { RefuelNearby } from "../usecases/fuel-rules";

/** How a refueling is placed on its vehicle's timeline. */
interface FuelPlacement {
  /**
   * The company's zone (Business.timezone). Readings of the record's own
   * civil day do not bound it: a web date is the day, not the moment.
   * Absent: the default zone.
   */
  timeZone?: string;
}

/** How a new refueling is written: placed, and its alerts decided. */
interface FuelCreation extends FuelPlacement {
  /**
   * The driver's reason when they confirmed a second refuelling of the
   * vehicle within 30 minutes (confirmedRecentReason, fuel-rules.ts); null
   * or absent when not confirmed. Stored only when the transaction finds
   * that other refuelling (recentRefuelAlert).
   */
  recentRefuelReason?: string | null;
}

/** When an edit changes a refueling's reading, date or vehicle. */
interface FuelMileageUpdate extends FuelPlacement {
  businessId: string;
  vehicleId: string;
  currentMileage: number;

  /** The refueling's date, where its reading sits on the odometer's timeline. */
  at: Date;

  /** The refueling being edited, never its own neighbour. */
  fuelId?: string;
}

interface IFuelRepository {
  createFuel: (fuelData: CreateFuelProps) => Promise<Fuel>;
  /**
   * The refueling, placed by its date (placeReading, fuel-rules.ts): between
   * the readings around it, the vehicle untouched; as the newest, ahead of
   * the odometer, which follows it; at the km of a neighbouring record less
   * than 30 minutes away, the vehicle untouched. Its alerts are decided in
   * the same serializable transaction (recentRefuelAlert): another
   * refuelling of the vehicle within 30 minutes of its date, either side,
   * flags it, also when both are sent at once.
   */
  createFuelWithMileage: (
    fuelData: CreateFuelProps,
    afterCreate?: (tx: Prisma.TransactionClient, fuel: Fuel) => Promise<void>,
    creation?: FuelCreation,
  ) => Promise<{ fuel: Fuel; created: boolean }>;
  /**
   * The vehicle's refuellings dated less than 30 minutes from `at`, either
   * side, inside the company (recentRefuelWindow), oldest first, at most
   * RECENT_REFUEL_CANDIDATE_LIMIT: what findRecentRefuel picks from.
   */
  findRefuelsNear: (
    businessId: string,
    vehicleId: string,
    at: Date,
  ) => Promise<RefuelNearby[]>;
  findBySubmissionId: (
    businessId: string,
    clientSubmissionId: string,
  ) => Promise<Fuel | null>;
  listFuels: (
    listFuelProps: ListFuelByBusinessIdProps,
  ) => Promise<ListFuelProps>;
  updateFuel: ({ fuelData, fuelId }: UpdateFuel) => Promise<Fuel>;
  /**
   * The edit and, when its reading, date or vehicle changes, the odometer,
   * decided in one transaction by placeReading (fuel-rules.ts) at `at`, the
   * refueling itself left out. A vehicle the refueling leaves gets back the
   * odometer it set (the highest reading left). An edit that moves the date
   * or the vehicle measures RECENT_REFUEL again (recheckedRecentRefuel),
   * keeping the driver's reason.
   */
  updateFuelAndMileage: (
    update: UpdateFuel,
    mileageUpdate?: FuelMileageUpdate,
  ) => Promise<Fuel>;
  /** The refueling and, when it set its vehicle's odometer, that km with it. */
  deleteFuel: (fuelId: string) => Promise<Fuel>;
  findFuelById: (fuelId: string) => Promise<Fuel | null>;
  findFuelByIdWithRelations: (fuelId: string) => Promise<any | null>;
  getFuelByIdAndBusiness({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<Fuel | null>;
  getFuelByIdAndBusinessWithRelations({
    businessId,
    fuelId,
  }: GetFuelByIdAndBusinessProps): Promise<any | null>;
  /**
   * Deletion guards count. The findFuelsBy{Vehicle,Driver,FuelType}Id
   * methods that loaded every refueling to read `.length` are gone: nothing
   * calls them any more, and an unbounded load should not be one import away.
   */
  countFuelsByVehicleId: (vehicleId: string) => Promise<number>;
  countFuelsByDriverId: (driverId: string) => Promise<number>;
  /** The list's own filters, so the file is what the screen shows (5.8). */
  streamFuelsForExport(filters: FuelListFilters): AsyncGenerator<any>;
  /** The refueling before `currentFuelDate`, within the company only. */
  getPreviousFuelByVehicleId: (
    vehicleId: string,
    currentFuelDate: Date | string,
    businessId: string,
  ) => Promise<Fuel | null>;
  searchFuelByVehicleWithCursor: (
    props: SearchFuelByVehicleWithCursorProps,
  ) => Promise<CursorPaginatedFuel>;
  countFuelForExport: (filters: FuelListFilters) => Promise<number>;

  /**
   * The refuellings made on a route, oldest first, inside the company (plan
   * of 02/11/2026, F3): what the route detail lists.
   */
  listRouteFuels: (
    businessId: string,
    routeId: string,
  ) => Promise<RouteFuelSummary[]>;
}

export { IFuelRepository };
export type { FuelCreation, FuelMileageUpdate, FuelPlacement };
