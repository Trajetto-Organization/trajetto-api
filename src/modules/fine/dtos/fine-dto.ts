import { Decimal } from "@prisma/client/runtime/client";
import { LocationSource, RecordOrigin } from "@prisma/client";

import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  FineListFilters,
  FineListGroup,
  FineListLabels,
  FineSortKey,
  FineStatus,
} from "../usecases/list-fine/fine-list";

interface Fine {
  id: string;
  violation_date: Date | string;
  due_date: Date | string;
  payment_date?: Date | string | null;
  amount: Decimal | string;
  points: number;
  location?: string | null;
  observation?: string | null;
  businessId: string;
  branchId: string;
  driverId: string;
  vehicleId: string;
  trafficViolationCodeId: string;
  created_at: Date | string;
  updated_at: Date | string;

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

  /** The Idempotency-Key of the create that made the row, or null. */
  client_submission_id?: string | null;

  /** Payment status on the company's business day (list rows only). */
  status?: FineStatus;

  /** The dates as days ("YYYY-MM-DD") in the company's zone (list rows only). */
  violation_day?: string;
  due_day?: string;
  payment_day?: string | null;

  // Extended fields for interface (do not exist in the bank)
  businessName?: string;
  branchName?: string;
  driverName?: string;
  driverCpf?: string;
  vehicleLicensePlate?: string;
  vehicleDescription?: string;
  violationCode?: string;
  violationDescription?: string;
}

interface CreateFineProps {
  violation_date: Date | string;
  due_date: Date | string;
  payment_date?: Date | string | null;
  amount: number;
  /** Absent: the code's points (the use case decides before saving). */
  points?: number;
  location?: string | null;
  observation?: string | null;
  businessId: string;
  branchId: string;
  driverId: string;
  vehicleId: string;
  trafficViolationCodeId: string;

  // 📍 GEOLOCATION: Final location (edited or original)
  latitude?: number | null;
  longitude?: number | null;

  // 📍 GEOLOCATION: Original GPS location (before any manual editing)
  latitude_original?: number | null;
  longitude_original?: number | null;

  // 🆕 GEOLOCATION AUDIT: Track location source and edits
  location_source?: LocationSource | null;
  /** Set by the use case from the session, never from the request. */
  location_edited_by?: string | null;
  location_edited_at?: Date | null;

  // 🆕 RECORD ORIGIN: Track where the record was created
  created_from: RecordOrigin;

  /** The web form's Idempotency-Key (IDEMP-14): the same key is one fine. */
  client_submission_id?: string | null;
}

/** What the repository saves: the points are always decided by then. */
type NewFine = Omit<CreateFineProps, "points"> & { points: number };

interface UpdateFineProps {
  violation_date?: Date | string;
  due_date?: Date | string;
  payment_date?: Date | string | null;
  amount?: number;
  points?: number;
  location?: string | null;
  observation?: string | null;
  branchId?: string;
  driverId?: string;
  vehicleId?: string;
  trafficViolationCodeId?: string;

  // 📍 GEOLOCATION: Final location (edited or original)
  latitude?: number | null;
  longitude?: number | null;

  /**
   * Written by the use case only. The request schema does not accept them:
   * a client that could send them could sign a location edit with somebody
   * else's name.
   */
  latitude_original?: number | null;
  longitude_original?: number | null;
  location_source?: LocationSource | null;
  location_edited_by?: string | null;
  location_edited_at?: Date | string | null;
}

interface UpdateFine {
  fineData: UpdateFineProps;
  fineId: string;
  /** The fine's company, in the `where` too: the second lock of the tenant rule. */
  businessId: string;
}

/** One company's fines, filtered as the list and the export read them. */
interface FineListQuery extends FineListFilters {
  /** First instant of the company's business day: the overdue line. */
  todayStart: Date;
  sort?: FineSortKey;
  order?: SortOrder;
}

interface ListFinesQuery extends FineListQuery {
  page: number;
  pageSize: number;
}

interface ListFinesResult {
  data: Fine[];
  /** Per (status, branch, code) over the base: pager, cards and options. */
  groups: FineListGroup[];
  labels: FineListLabels;
}

/** One line of the export, flattened. */
interface FineExportRow {
  id: string;
  violation_date: Date;
  due_date: Date;
  payment_date: Date | null;
  status: FineStatus;
  amount: number;
  points: number;
  location: string | null;
  observation: string | null;
  branchName: string | null;
  driverName: string | null;
  driverCpf: string | null;
  vehicleLicensePlate: string | null;
  vehicleDescription: string | null;
  violationCode: string | null;
  violationDescription: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at: Date;
  updated_at: Date;
}

export {
  Fine,
  CreateFineProps,
  NewFine,
  UpdateFineProps,
  UpdateFine,
  FineListQuery,
  ListFinesQuery,
  ListFinesResult,
  FineExportRow,
};
