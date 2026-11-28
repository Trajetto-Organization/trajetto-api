import { Decimal } from "@prisma/client/runtime/client";
import { FuelAlert, LocationSource, RecordOrigin } from "@prisma/client";

import type { SortOrder } from "@/shared/pagination/list-query";
import type {
  FuelListFilters,
  FuelListGroup,
  FuelListLabels,
  FuelSortKey,
} from "../usecases/list-fuel/fuel-list";
import type { DevicePrecheck } from "@/shared/ai-precheck/device-precheck";
import type { ListedRoute } from "@/shared/vehicle/route-columns";

interface Fuel {
  id: string;
  client_submission_id?: string | null;
  current_mileage: number;
  liters_amount: Decimal;
  price_per_liter: Decimal;
  total_amount: Decimal;
  odometer_photo?: string | null;
  odometer_verified: boolean;
  notes?: string | null;
  refueling_date: Date | string;
  businessId: string;
  branchId: string;
  vehicleId: string;
  driverId: string;
  fuelTypeId: string;

  // 📍 GEOLOCATION: Final location (edited or original)
  latitude?: number | null;
  longitude?: number | null;

  // 📍 GEOLOCATION: Original GPS location (before any manual editing)
  latitude_original?: number | null;
  longitude_original?: number | null;

  // 🆕 GEOLOCATION AUDIT: Track location source and edits
  location_source?: LocationSource | null;
  location_edited_by?: string | null;
  location_edited_at?: Date | string | null;

  // 🆕 RECORD ORIGIN: Track where the record was created
  created_from: RecordOrigin;

  /**
   * What the office should look at (05/11/2026, fuel-rules.ts): RECENT_REFUEL
   * for another refuelling of the vehicle within 30 minutes. Always read
   * from the database (empty by default); optional here for the fixtures
   * written before it.
   */
  alerts?: FuelAlert[];

  /** The driver's reason when they confirmed RECENT_REFUEL; null otherwise. */
  recent_refuel_reason?: string | null;

  /** The other refuelling's date behind RECENT_REFUEL; null otherwise. */
  recent_refuel_previous_at?: Date | string | null;

  // AI Verification fields
  odometer_ai_reading?: number | null;
  odometer_ai_status: string;
  odometer_ai_details?: any;
  odometer_ai_analyzed_at?: Date | string | null;

  /** The route it was made on (plan of 02/11/2026, C5/F3); null outside one. */
  routeId?: string | null;

  created_at: Date | string;
  updated_at: Date | string;
}

interface CreateFuelProps {
  client_submission_id?: string;
  current_mileage: number;
  liters_amount: number | string | Decimal;
  price_per_liter: number | string | Decimal;
  total_amount?: number | string | Decimal;
  odometer_photo?: string;
  odometer_verified?: boolean;
  notes?: string | null;
  refueling_date: Date | string;
  businessId: string;
  branchId?: string; // Optional for driver users (auto-populated)
  vehicleId: string;
  driverId?: string; // Optional for driver users (auto-populated)
  fuelTypeId: string;

  // 📍 GEOLOCATION: Final location (edited or original)
  latitude?: number | null;
  longitude?: number | null;

  // 📍 GEOLOCATION: Original GPS location (before any manual editing)
  latitude_original?: number | null;
  longitude_original?: number | null;

  // 🆕 GEOLOCATION AUDIT: Track location source and edits
  location_source?: LocationSource | null;

  // 🆕 RECORD ORIGIN: Track where the record was created
  created_from: RecordOrigin;

  /**
   * The route it was made on (plan of 02/11/2026, C5/F3). The use case
   * checks it is the driver's route and the vehicle is the route's.
   */
  routeId?: string | null;

  /**
   * The phone's offline check of the odometer photo, as sent (decision
   * 14.2). The use case moves it to `odometer_device_precheck` or drops it.
   */
  device_precheck?: DevicePrecheck | null;

  /** Where the accepted check is stored; set by the use case only. */
  odometer_device_precheck?: DevicePrecheck;

  /**
   * The driver's answer to a second refuelling of the vehicle within 30
   * minutes (05/11/2026), as sent. Not columns: the use case takes them out
   * and hands the repository the confirmed reason (confirmedRecentReason).
   */
  confirm_recent?: boolean;
  recent_reason?: string;
}

interface UpdateFuelProps {
  current_mileage?: number;
  liters_amount?: number | string | Decimal;
  price_per_liter?: number | string | Decimal;
  total_amount?: number | string | Decimal;
  odometer_photo?: string | null;
  odometer_verified?: boolean;
  notes?: string | null;
  refueling_date?: Date | string;
  branchId?: string;
  vehicleId?: string;
  driverId?: string;
  fuelTypeId?: string;

  // 📍 GEOLOCATION: Final location (edited or original)
  latitude?: number | null;
  longitude?: number | null;

  // 📍 GEOLOCATION: Original GPS location (before any manual editing)
  latitude_original?: number | null;
  longitude_original?: number | null;

  // 🆕 GEOLOCATION AUDIT: Track location source and edits
  location_source?: LocationSource | null;
  location_edited_by?: string | null;
  location_edited_at?: Date | string | null;
}

interface UpdateFuel {
  fuelData: Partial<UpdateFuelProps>;
  fuelId: string;
}

/**
 * A refuelling as the list and the vehicle history send it: the record, its
 * relation names, and the route it was made on (contract C3; null outside
 * one or when the route is not the row's company's).
 */
type FuelListRow = Fuel & { route: ListedRoute | null };

interface ListFuelProps {
  data: FuelListRow[];
  /** Refuelings per facet combination over the base (search + scope). */
  groups: FuelListGroup[];
  /** Names of the branches, vehicles and fuel types the options point at. */
  labels: FuelListLabels;
}

interface ListFuelByBusinessIdProps extends FuelListFilters {
  page: number;
  pageSize: number;
  sort?: FuelSortKey;
  order?: SortOrder;
}

interface GetFuelByIdAndBusinessProps {
  businessId: string;
  fuelId: string;
}

interface FuelWithRelations {
  id: string;
  current_mileage: number;
  liters_amount: Decimal;
  price_per_liter: Decimal;
  total_amount: Decimal;
  odometer_photo?: string | null;
  odometer_verified: boolean;
  notes?: string | null;
  refueling_date: Date | string;
  businessId: string;
  branchId: string;
  vehicleId: string;
  driverId: string;
  fuelTypeId: string;
  created_at: Date | string;
  updated_at: Date | string;
  business: {
    id: string;
    corporate_reason: string;
    fantasy_name?: string | null;
  };
  branch: {
    id: string;
    corporate_reason: string;
    fantasy_name?: string | null;
  };
  vehicle: {
    id: string;
    description: string;
    license_plate: string;
    brand: string;
    model: string;
    current_mileage: number;
  };
  driver: {
    id: string;
    name: string;
    cnh: string;
  };
  fuelType: {
    id: string;
    description: string;
  };
}

interface SearchFuelByVehicleWithCursorProps {
  limit: number;
  cursor?: string;
  vehicleId: string;
  businessId: string;
  search?: string;

  /**
   * A driver's own refuelings only (decision 4.4, DRV-SCOPE-1): the history
   * is open to whoever may operate the vehicle, not the colleagues' records.
   */
  driverId?: string;
}

interface CursorPaginatedFuel {
  data: FuelListRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The previous refueling as the consumption needs it (km, date, litres):
 * nothing about who fueled, where, at what price or with which photo.
 */
interface PreviousFuelReading {
  vehicleId: string;
  refueling_date: Date | string;
  current_mileage: number;
  liters_amount: number;
}

/**
 * A refuelling made on a route, as the route detail lists it (plan of
 * 02/11/2026, F3): the amounts as plain numbers, no photo or location.
 */
interface RouteFuelSummary {
  id: string;
  refueling_date: Date;
  liters_amount: number;
  price_per_liter: number;
  total_amount: number;
  current_mileage: number;
  vehicleId: string;
  driverId: string;
  odometer_ai_status: string;

  /** Its alerts and what raised RECENT_REFUEL (05/11/2026), as the list. */
  alerts: FuelAlert[];
  recent_refuel_reason: string | null;
  recent_refuel_previous_at: Date | null;
}

export {
  Fuel,
  CreateFuelProps,
  UpdateFuelProps,
  UpdateFuel,
  ListFuelProps,
  ListFuelByBusinessIdProps,
  GetFuelByIdAndBusinessProps,
  FuelListRow,
  FuelWithRelations,
  SearchFuelByVehicleWithCursorProps,
  CursorPaginatedFuel,
  PreviousFuelReading,
  RouteFuelSummary,
};
