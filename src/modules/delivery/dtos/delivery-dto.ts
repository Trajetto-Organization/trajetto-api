import { DeliveryStatus } from "@/shared/delivery/delivery-rules";

interface DeliveryItemInput {
  description: string;
  quantity?: number;
  unit?: string | null;
  unit_value?: number | null;
}

interface Delivery {
  id?: string;
  code?: string | null;
  invoice_key?: string | null;
  invoice_number?: string | null;
  recipient_name: string;
  recipient_document?: string | null;
  recipient_email?: string | null;
  recipient_telephone?: string | null;
  cep?: string | null;
  city: string;
  uf: string;
  street: string;
  address_number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  status: DeliveryStatus;
  scheduled_date?: Date | string | null;
  delivered_at?: Date | string | null;
  received_by?: string | null;
  notes?: string | null;
  businessId: string;
  shipperId: string;
  vehicleId?: string | null;
  driverId?: string | null;
  created_at?: Date | string;
  updated_at?: Date | string;
}

interface CreateDeliveryProps {
  code?: string | null;
  invoice_key?: string | null;
  invoice_number?: string | null;
  recipient_name: string;
  recipient_document?: string | null;
  recipient_email?: string | null;
  recipient_telephone?: string | null;
  cep?: string | null;
  city: string;
  uf: string;
  street: string;
  address_number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  scheduled_date?: Date | null;
  notes?: string | null;
  businessId: string;
  shipperId: string;
  vehicleId?: string | null;
  driverId?: string | null;
  items?: DeliveryItemInput[];
}

interface UpdateDeliveryProps {
  code?: string | null;
  recipient_name?: string;
  recipient_document?: string | null;
  recipient_email?: string | null;
  recipient_telephone?: string | null;
  cep?: string | null;
  city?: string;
  uf?: string;
  street?: string;
  address_number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  scheduled_date?: Date | null;
  notes?: string | null;
  shipperId?: string;
  vehicleId?: string | null;
  driverId?: string | null;
}

interface ListDeliveriesProps {
  page: number;
  pageSize: number;
  businessId: string;
  status?: DeliveryStatus;
  shipperId?: string;
  driverId?: string;
  search?: string;
}

interface ListDeliveriesResult {
  data: Delivery[];
  total: number;
  /** Rides along in the NDJSON meta line — feeds the panel cards. */
  meta?: { statusCounts: Record<string, number> };
}

interface CreateOccurrenceProps {
  deliveryId: string;
  occurrenceTypeId: string;
  reportedById: string;
  description?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  photos?: string[];
  client_submission_id?: string | null;
}

interface ListOccurrencesProps {
  page: number;
  pageSize: number;
  businessId: string;
  blocksDelivery?: boolean;
  occurrenceTypeId?: string;
  /** Present for driver tokens: they only see their own deliveries. */
  driverId?: string;
  search?: string;
}

interface ListOccurrencesResult {
  data: unknown[];
  total: number;
  currentPage: number;
  pageSize: number;
  totalPages: number;
}

interface DriverOperationRow {
  driverId: string;
  driverName: string;
  cnh: string;
  designated: number;
  inRoute: number;
  deliveredToday: number;
  failedToday: number;
}

interface OperationSummary {
  totals: {
    /** PENDING without a driver — what the dispatcher still owes a route. */
    unassigned: number;
    designated: number;
    inRoute: number;
    deliveredToday: number;
    failedToday: number;
    occurrencesToday: number;
  };
  drivers: DriverOperationRow[];
}

type DeliveryEventType = "ARRIVAL" | "PROOF";

interface CreateDeliveryEventProps {
  type: DeliveryEventType;
  deliveryId: string;
  reportedById: string;
  latitude?: number | null;
  longitude?: number | null;
  photo?: string | null;
  signature?: string | null;
  received_by?: string | null;
  /** Outbox idempotency anchor — unique in the database. */
  client_submission_id: string;
}

interface DeliveryEventRecord {
  id: string;
  type: DeliveryEventType;
  deliveryId: string;
  client_submission_id: string | null;
}

export {
  Delivery,
  DeliveryItemInput,
  CreateDeliveryProps,
  UpdateDeliveryProps,
  ListDeliveriesProps,
  ListDeliveriesResult,
  CreateOccurrenceProps,
  ListOccurrencesProps,
  ListOccurrencesResult,
  DriverOperationRow,
  OperationSummary,
  DeliveryEventType,
  CreateDeliveryEventProps,
  DeliveryEventRecord,
};
