import { Decimal } from "@prisma/client/runtime/client";
import { LocationSource, RecordOrigin } from "@prisma/client";

import type { FacetCount } from "@/shared/pagination/list-meta";
import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  MaintenanceTypeValue,
  ServiceOrderSortKey,
  ServiceOrderStatus,
  ServiceOrderTypeCount,
} from "../usecases/list-service-order/service-order-list";

interface ServiceOrder {
  id: string;
  date: Date | string;
  completion_date?: Date | string | null;
  maintenance_type: "INTERNAL" | "EXTERNAL";
  total_amount: Decimal | string;
  description?: string | null;
  businessId: string;
  vehicleId: string;
  responsibleUserId: string;
  branchId: string;
  supplierId?: string | null;
  created_at: Date | string;
  updated_at: Date | string;

  // 📸 SNAPSHOT: Vehicle data at the time the work order was created.
  current_mileage_at_service?: number | null;
  maintenance_interval_km_at_service?: number | null;
  last_maintenance_mileage_at_service?: number | null;

  // 🔧 NEW MILEAGE: Provided upon completion
  new_mileage_after_service?: number | null;

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

  // Extended fields for the interface only (do not exist in the database)
  vehicleLicensePlate?: string;
  vehicleDescription?: string;
  responsibleUserName?: string;
  branchName?: string;
  supplierName?: string;
  partsCount?: number;
}

interface CreateServiceOrderProps {
  date: Date | string;
  completion_date?: Date | null | string;
  maintenance_type: "INTERNAL" | "EXTERNAL";
  total_amount: number;
  description?: string | null;
  current_mileage_at_service: number;
  maintenance_interval_km_at_service: number;
  last_maintenance_mileage_at_service?: number | null;
  new_mileage_after_service?: number | null;
  businessId: string;
  vehicleId: string;
  responsibleUserId: string;
  branchId: string;
  supplierId?: string | null;

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

  /** The web form's Idempotency-Key (IDEMP-14): the same key is one order. */
  client_submission_id?: string | null;
}

interface UpdateServiceOrderProps {
  date?: Date | null | string;
  completion_date?: Date | null | string;
  maintenance_type?: "INTERNAL" | "EXTERNAL";
  total_amount?: number;
  description?: string | null;
  new_mileage_after_service?: number | null;
  // The snapshot, as the form posts it: applied from the MASTER only.
  current_mileage_at_service?: number | null;
  maintenance_interval_km_at_service?: number | null;
  last_maintenance_mileage_at_service?: number | null;
  vehicleId?: string;
  responsibleUserId?: string;
  branchId?: string;
  supplierId?: string | null;

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

interface UpdateServiceOrder {
  serviceOrderData: UpdateServiceOrderProps;
  serviceOrderId: string;
}

/** A listed order: the row plus what the screen derives from its links. */
interface ServiceOrderListRow extends ServiceOrder {
  /** Σ of its parts (unit price × quantity − discount), for the total_amount warning. */
  parts_total: number;
  parts_count: number;
  /** Bills linked to it: a linked order cannot be deleted (FLEET-SO-1). */
  accounts_payable_count: number;
}

/** What the repository answers; the use case turns the counts into searchMeta. */
interface ListServiceOrderProps {
  data: ServiceOrderListRow[];
  /** Orders and money per status × type, over search + branch facet. */
  cells: ServiceOrderTypeCount[];
  /** Branch options with their counts, over search + status + type. */
  branchCounts: FacetCount[];
}

/** The listing's filters, shared by the export (decision 5.8). */
interface ServiceOrderListQuery {
  businessId: string;
  search?: string;
  statuses?: ServiceOrderStatus[];
  maintenanceTypes?: MaintenanceTypeValue[];
  branchIds?: string[];
}

interface ListServiceOrderByBusinessIdProps extends ServiceOrderListQuery {
  page: number;
  pageSize: number;
  sort?: ServiceOrderSortKey;
  order?: SortOrder;
}

interface SearchServiceOrderWithCursorProps {
  limit: number;
  cursor?: string;
  businessId: string;
  /** The picker's typed term: vehicle plate or description, order description. */
  search?: string;
}

/** Why an order may not be deleted, counted inside the delete's lock. */
interface ServiceOrderDeleteBlock {
  completed: boolean;
  accountsPayable: number;
}

type DeleteServiceOrderResult =
  | { deleted: ServiceOrder; partsRemoved: number }
  | { blocked: ServiceOrderDeleteBlock }
  /** Gone (or never this company's) by the time the lock was taken. */
  | { missing: true };

interface CursorPaginatedServiceOrder {
  data: ServiceOrder[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface SearchServiceOrderByVehicleWithCursorProps {
  limit: number;
  cursor?: string;
  vehicleId: string;
  businessId: string;
}

export {
  ServiceOrder,
  ServiceOrderListRow,
  ServiceOrderListQuery,
  ServiceOrderDeleteBlock,
  DeleteServiceOrderResult,
  CreateServiceOrderProps,
  UpdateServiceOrderProps,
  UpdateServiceOrder,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  SearchServiceOrderWithCursorProps,
  CursorPaginatedServiceOrder,
  SearchServiceOrderByVehicleWithCursorProps,
};
