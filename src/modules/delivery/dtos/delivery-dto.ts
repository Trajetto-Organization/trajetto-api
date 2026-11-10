import { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import type { DeliveryKind } from "@/shared/delivery/delivery-kind";
import type { SortOrder } from "@/shared/pagination/list-query";

import type {
  OccurrenceFeedFilters,
  OccurrenceSortKey,
  OccurrenceTypeCount,
} from "../usecases/list-occurrences/occurrence-feed";

import type {
  DeliveryListFilters,
  DeliveryListSearchMeta,
  DeliverySortKey,
  GroupCount,
} from "../usecases/list-delivery/delivery-list";

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
  /** DELIVERY, PICKUP or SERVICE_ORDER (meeting of 14/10/2026). */
  kind?: DeliveryKind;
  scheduled_date?: Date | string | null;
  delivered_at?: Date | string | null;
  received_by?: string | null;
  notes?: string | null;
  businessId: string;
  shipperId: string;
  vehicleId?: string | null;
  driverId?: string | null;
  /** The upload that created it (spreadsheet or NF-e XML), when one did. */
  importId?: string | null;
  /**
   * The API key that created it through POST /integration/v1/deliveries: the
   * origin INTEGRATION (decision 5.10). Null for the panel and the imports.
   */
  apiKeyId?: string | null;
  /**
   * The ADDRESS point (decision 14.7): pinned by the dispatcher or given at
   * the create (MANUAL), or found by the geocoder (GEOCODER, plan of
   * 02/11/2026 E1, with the level it reached in geo_precision). What the
   * geofence measures from (E2/E4).
   */
  latitude?: number | null;
  longitude?: number | null;
  geo_source?: "MANUAL" | "GEOCODER" | null;
  geo_updated_at?: Date | null;
  geo_precision?: "ADDRESS" | "STREET" | "NEIGHBORHOOD" | "CITY" | null;
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

  /**
   * The address point given at the create — the panel's form, the
   * spreadsheet, the public API (plan of 02/11/2026, E1). The repository
   * stores a whole pair as the point with geo_source MANUAL
   * (manualAddressPoint) and nothing otherwise, so the geocoder's queue
   * keeps a row created without one.
   */
  latitude?: number | null;
  longitude?: number | null;

  scheduled_date?: Date | null;
  notes?: string | null;
  /** Absent = DELIVERY (the column default). */
  kind?: DeliveryKind;
  businessId: string;
  shipperId: string;
  vehicleId?: string | null;
  driverId?: string | null;
  items?: DeliveryItemInput[];

  /** The upload that created it, when one did. See the Import model. */
  importId?: string | null;

  /**
   * The web form's (or an integration's) Idempotency-Key (IDEMP-14): the
   * same key is one delivery. Unique per company.
   */
  client_submission_id?: string | null;

  /**
   * The API key that created it through POST /integration/v1/deliveries: the
   * origin INTEGRATION (decision 5.10). The panel and the imports leave it
   * out.
   */
  apiKeyId?: string | null;
}

interface UpdateDeliveryProps {
  code?: string | null;
  /** Set once (decision 5.2); the use case refuses a change of a set key. */
  invoice_key?: string | null;
  invoice_number?: string | null;
  /** Replaces the item list; refused on a delivery imported from an NF-e. */
  items?: DeliveryItemInput[];
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
  kind?: DeliveryKind;
  shipperId?: string;
  // No driverId/vehicleId (DLV-EDIT-4): assignment builds the route.

  // Never from the request: the use case clears the address point when the
  // address changes (decision 14.7, design §4.11) — and the geocoder's
  // bookkeeping with it (plan of 02/11/2026, E1).
  latitude?: null;
  longitude?: null;
  geo_source?: null;
  geo_updated_at?: null;
  geo_precision?: null;
  geocode_status?: null;
  geocode_attempted_at?: null;
  geocode_attempts?: 0;
}

interface ListDeliveriesProps extends DeliveryListFilters {
  page: number;
  pageSize: number;
  sort?: DeliverySortKey;
  order?: SortOrder;

  /**
   * leftOpenStartedBefore for the company's zone and now (plan of
   * 02/11/2026, H3): when given, the page also counts, per route left open,
   * the open stops of the documents the "Em Rota" card counts.
   */
  leftOpenBefore?: Date;
}

/** A catalog facet's options, labelled from the company's own records. */
interface DeliveryFacetOption {
  value: string;
  label: string;
  count: number;
}

/**
 * The page, and the grouped counts the use case turns into the pager total,
 * the cards and the filter options (see summarizeDeliveryList).
 */
interface ListDeliveriesPage {
  data: Delivery[];
  /**
   * Whether the requested period narrowed the rows: false without one, and
   * false when an exact id / order / NF search set it aside.
   */
  periodApplied: boolean;
  /** Per status, with every filter but the status facet. */
  statusCounts: GroupCount[];
  shipperOptions: DeliveryFacetOption[];
  driverOptions: DeliveryFacetOption[];

  /**
   * With `leftOpenBefore`: each route left open (IN_PROGRESS, started
   * before it) holding open stops (PENDING/ARRIVED) of IN_TRANSIT documents
   * that match every filter but the status — the card's own set — and how
   * many. Routes holding none are left out. Absent without `leftOpenBefore`.
   */
  leftOpenRoutes?: Array<{ started_at: Date | null; open: number }>;
}

interface ListDeliveriesResult {
  data: Delivery[];
  total: number;
  /** Rides along in the NDJSON meta line — the cards and the filters. */
  meta?: DeliveryListSearchMeta;
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

  /**
   * When the driver reported it, for a report the app sent later (see
   * resolveOccurredAt). Absent or null means "when it was received".
   */
  occurred_at?: Date | null;

  /** The validated answers to the type's form, by field key (decision 6.2). */
  form_answers?: Record<string, string | number | boolean> | null;
  /** The type's form_version the answers were validated against. */
  form_version?: number | null;

  /**
   * Decision 6.3. Absent = NOT_REQUIRED (the column default). PENDING holds
   * the effect back; APPROVED on a panel report of such a type records that
   * its own author authorized it.
   */
  authorization_status?: OccurrenceAuthorizationStatus;
  authorizedById?: string | null;
  authorized_at?: Date | null;

  /** Copied from the type (decision 14.3); absent = NOT_DELIVERED. */
  category?: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";
  /** Storage keys validated against the bucket (deliveryPhotos of the company). */
  receipt_photo?: string | null;
  signature?: string | null;
  /** DELIVERED only: who received it. */
  received_by?: string | null;

  /**
   * The geofence record of the report (plan of 02/11/2026, E3/E4): metres
   * to the address point, the phone's accuracy and the verdict. An
   * occurrence is never refused for the radius; OUTSIDE flags it for review.
   * Absent = not evaluated by this server (null in the row).
   */
  distance_m?: number | null;
  accuracy_m?: number | null;
  geofence_outcome?: GeofenceOutcome | null;
}

/**
 * Where an action at the customer's address was made, relative to the
 * company's radius (plan of 02/11/2026, E2): the GeofenceOutcome enum.
 */
type GeofenceOutcome = "INSIDE" | "OUTSIDE" | "NOT_EVALUATED";

/** DeliveryOccurrence.authorization_status (decision 6.3). */
type OccurrenceAuthorizationStatus =
  "NOT_REQUIRED" | "PENDING" | "APPROVED" | "DENIED" | "SUPERSEDED";

interface ListOccurrencesProps extends OccurrenceFeedFilters {
  page: number;
  pageSize: number;
  sort?: OccurrenceSortKey;
  order?: SortOrder;
}

interface ListOccurrencesResult {
  data: unknown[];
  /**
   * Per type over scope, search and status (no type or severity facet), plus
   * any selected type of the company with count 0. The use case derives the
   * pager total, the cards and the filter options from it.
   */
  typeCounts: OccurrenceTypeCount[];
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

/**
 * Everything that can land on a delivery's trail.
 *
 * ARRIVAL and PROOF come from the driver's app. STATUS_CHANGE and NOTE come
 * from the support timeline: a status moved by hand used to be a column that
 * changed, so "why is this one Insucesso?" had no answer three days later,
 * and an operator's annotation had nowhere to live at all.
 */
type DeliveryEventType =
  | "ARRIVAL"
  | "PROOF"
  | "STATUS_CHANGE"
  | "NOTE"
  // Decision 6.4 and TWR-6: "a caminho" and an occurrence on the trail.
  | "ON_THE_WAY"
  | "OCCURRENCE"
  // Decision 14.7: the delivery joined or left a route (event.routeId).
  | "ROUTE_ADDED"
  | "ROUTE_REMOVED";

/**
 * Who produced an event. The timeline has to say so and cannot infer it: a
 * status moved by a person on the web and one moved by an integration look
 * identical in the columns.
 */
type DeliveryEventActor = "USER" | "DRIVER_APP" | "INTEGRATION" | "SYSTEM";

interface CreateDeliveryEventProps {
  type: DeliveryEventType;
  deliveryId: string;

  /**
   * Absent only for an actor that is not a person — an integration or the
   * platform itself. Every source today has one.
   */
  reportedById?: string | null;

  actor?: DeliveryEventActor;

  /**
   * INTEGRATION only: the API key that acted (L9), so the trail names it
   * instead of a bare "integração". Null for every other actor.
   */
  apiKeyId?: string | null;

  /** DRIVER_APP only: which phone sent it. */
  device?: string | null;

  latitude?: number | null;
  longitude?: number | null;
  photo?: string | null;
  signature?: string | null;
  received_by?: string | null;

  /** Required on a NOTE; optional detail alongside a STATUS_CHANGE. */
  note?: string | null;

  // STATUS_CHANGE only.
  status_from?: DeliveryStatus | null;
  status_to?: DeliveryStatus | null;
  reasonId?: string | null;

  /**
   * Outbox idempotency anchor — unique in the database.
   *
   * Optional because only the driver's app resends: an operator clicking twice
   * on the web makes two deliberate events, and a support timeline that
   * collapsed them would hide that somebody did it twice.
   */
  client_submission_id?: string | null;

  /**
   * When it happened, for an action the app sent later (see
   * resolveOccurredAt). Absent or null means "when it was received"; the
   * row's created_at stays the receipt, which incremental readers page by.
   */
  occurred_at?: Date | null;

  /**
   * OCCURRENCE, and the STATUS_CHANGE an authorization decision causes: the
   * occurrence the event is about (TWR-6), so the feed can name its type.
   * PROOF: the DELIVERED occurrence it is the effect of (decision 14.3).
   */
  occurrenceId?: string | null;

  /** The route the delivery was on when it happened, when it was on one. */
  routeId?: string | null;

  /** PROOF from the app (decision 14.8): the phone's stable id. */
  device_id?: string | null;

  /** PROOF from the app: when the receipt photo was taken (server clock). */
  photo_taken_at?: Date | null;

  /**
   * ARRIVAL and PROOF (plan of 02/11/2026, E2/E4): metres to the address
   * point and the phone's accuracy, as the server computed them, and the
   * verdict. OUTSIDE is the "fora do raio" flag. Absent = not evaluated.
   */
  distance_m?: number | null;
  accuracy_m?: number | null;
  geofence_outcome?: GeofenceOutcome | null;
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
  ListDeliveriesPage,
  ListDeliveriesResult,
  DeliveryFacetOption,
  CreateOccurrenceProps,
  GeofenceOutcome,
  OccurrenceAuthorizationStatus,
  ListOccurrencesProps,
  ListOccurrencesResult,
  DriverOperationRow,
  OperationSummary,
  DeliveryEventType,
  DeliveryEventActor,
  CreateDeliveryEventProps,
  DeliveryEventRecord,
};
