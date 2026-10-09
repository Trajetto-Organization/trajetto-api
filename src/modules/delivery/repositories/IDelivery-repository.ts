import { Prisma } from "@prisma/client";

import { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import type { OperationDay } from "@/modules/route/repositories/IOperation-day-repository";
import {
  Delivery,
  CreateDeliveryProps,
  UpdateDeliveryProps,
  ListDeliveriesProps,
  ListDeliveriesPage,
  CreateOccurrenceProps,
  CreateDeliveryEventProps,
  DeliveryEventRecord,
  ListOccurrencesProps,
  ListOccurrencesResult,
  OccurrenceAuthorizationStatus,
} from "../dtos/delivery-dto";
import type { DeliveryListFilters } from "../usecases/list-delivery/delivery-list";
import type { OccurrenceFeedFilters } from "../usecases/list-occurrences/occurrence-feed";

interface DeliveryStatusPatch {
  status: DeliveryStatus;

  /**
   * The status the caller read and ran `canTransitionDelivery` against.
   *
   * Required, not optional, so that adding a status write to this module
   * cannot silently skip the check: the compiler asks for it at every call
   * site. The write only lands while the row still holds this value.
   */
  expectedStatus: DeliveryStatus;

  delivered_at?: Date | null;
  received_by?: string | null;
}

interface DeliveryAssignmentPatch {
  driverId: string;
  /** null clears the vehicle — each assignment fully defines the pair. */
  vehicleId: string | null;
}

/** What the operation summary reads outside the tower's day (see below). */
interface OperationBacklog {
  /** PENDING without a driver, of any date: the "Sem rota" backlog. */
  unassigned: number;

  /** Reports by a driver's account that happened in the day. */
  occurrencesToday: number;
}

interface IDeliveryRepository {
  createDelivery: (
    deliveryData: CreateDeliveryProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<Delivery>;
  /** The delivery a submission with this key already created, in this company. */
  findDeliveryBySubmissionId: (
    businessId: string,
    clientSubmissionId: string,
  ) => Promise<Delivery | null>;
  /**
   * The page (ordered by the list's sort spec) and the grouped counts of the
   * cards and filters, with at most two queries in flight at once.
   */
  listDeliveries: (props: ListDeliveriesProps) => Promise<ListDeliveriesPage>;
  findDeliveryById: (deliveryId: string) => Promise<Delivery | null>;
  findDeliveryDetailById: (deliveryId: string) => Promise<unknown | null>;
  findDeliveryByInvoiceKey: (
    businessId: string,
    invoiceKey: string,
  ) => Promise<Delivery | null>;
  /**
   * Edits only from the expected status. Without `expectedStatus` this is a
   * read-then-write, and the window between them is where the driver proves
   * the delivery the panel is editing.
   */
  updateDelivery: (
    deliveryId: string,
    deliveryData: UpdateDeliveryProps,
    expectedStatus?: DeliveryStatus,
  ) => Promise<Delivery>;
  /**
   * Where the delivery came from: the source of the upload that created it,
   * or null for one typed in the panel (or whose upload was reversed).
   * Decides whether its items are the NF-e's (locked) or the dispatcher's.
   */
  findDeliveryImportSource: (
    deliveryId: string,
  ) => Promise<"SPREADSHEET" | "NFE_XML" | null>;
  /**
   * The route holding the delivery's open stop (PENDING or ARRIVED), or null
   * when it is on no route. At most one open stop exists per delivery
   * (partial unique index).
   */
  findOpenStopRoute: (
    deliveryId: string,
  ) => Promise<{ routeId: string; status: string } | null>;
  /**
   * Moves a delivery, but only from `patch.expectedStatus`. Throws
   * DeliveryStatusConflictError (writing nothing) when the row already moved.
   */
  updateDeliveryStatus: (
    deliveryId: string,
    patch: DeliveryStatusPatch,
    tx?: Prisma.TransactionClient,
  ) => Promise<Delivery>;
  findDeliveriesByIds: (deliveryIds: string[]) => Promise<Delivery[]>;
  /**
   * All-or-nothing: throws DeliveryAssignmentConflictError (writing
   * nothing) when any row is no longer PENDING between validation and
   * write.
   */
  assignDeliveries: (
    deliveryIds: string[],
    assignment: DeliveryAssignmentPatch,
    tx?: Prisma.TransactionClient,
  ) => Promise<void>;
  /** Returns the new row's id: the OCCURRENCE event points at it (TWR-6). */
  createOccurrence: (
    occurrenceData: CreateOccurrenceProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<{ id: string }>;
  /**
   * The submission already stored with this key, WITHIN this company. The
   * column is globally unique and this runs before any ownership check:
   * unscoped, another company's key would read as "already exists" and the
   * idempotent path would swallow the write with a 200.
   */
  findOccurrenceBySubmissionId: (
    clientSubmissionId: string,
    businessId: string,
  ) => Promise<{
    id: string;
    /** A replay answers with where the first submission stands (6.3). */
    authorization_status: OccurrenceAuthorizationStatus;
    /** Decision 14.3: a delivered replay also answers the delivery's status. */
    category: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";
  } | null>;
  /**
   * The manager's cross-delivery occurrence feed: one page in the requested
   * order, plus the per-type counts its cards, filters and pager come from.
   */
  listOccurrences: (props: ListOccurrencesProps) => Promise<ListOccurrencesResult>;
  /**
   * The two numbers of the monitoring panel and the dashboard's "Operação de
   * hoje" that are not the tower's day: the backlog without a driver (any
   * date) and the driver's reports of `day`. The day's documents themselves
   * come from OperationDayRepository.countDayDeliveries (decision 7.1), read
   * by readOperationSummary. The caller picks the day; the repository never
   * reads the server's clock.
   */
  operationBacklog: (
    businessId: string,
    day: OperationDay,
  ) => Promise<OperationBacklog>;
  /** The driver's working list: own PENDING (designated) + IN_TRANSIT. */
  listDriverDeliveries: (
    businessId: string,
    driverId: string,
  ) => Promise<unknown[]>;
  /**
   * How many of the driver's deliveries are still waiting to leave.
   * `createdUpTo` bounds it to what existed at a tap sent late (MOB-08).
   */
  countPendingForDriver: (
    businessId: string,
    driverId: string,
    createdUpTo?: Date,
  ) => Promise<number>;
  /**
   * PENDING -> IN_TRANSIT for the driver's batch; returns how many moved.
   * `createdUpTo`: only deliveries created at or before it (the tap).
   */
  startDriverRoute: (
    businessId: string,
    driverId: string,
    createdUpTo?: Date,
  ) => Promise<number>;
  /** Same scoping, and the same reason, as `findOccurrenceBySubmissionId`. */
  findEventBySubmissionId: (
    clientSubmissionId: string,
    businessId: string,
  ) => Promise<DeliveryEventRecord | null>;
  /**
   * How many deliveries reference this driver or this vehicle, of any status.
   *
   * Asked before a hard delete. Both columns are optional relations, so
   * Postgres NULLs them instead of refusing — a DELIVERED delivery with a
   * delivered_at and nobody who delivered it. This count is what turns that
   * silence into a refusal the operator can read.
   */
  /**
   * The other identity a delivery can have.
   *
   * A company that issues invoices is deduplicated by the access key, which
   * has a unique index. One that works from order numbers has neither, so the
   * import asks here — (shipper, pedido) is the pair that means "the same
   * job" for them.
   *
   * With `tx`, the read runs inside the caller's transaction: after
   * `lockOrderIdentity` it sees whatever a concurrent writer of the same
   * order committed while this one waited.
   */
  findDeliveryByShipperAndCode: (
    businessId: string,
    shipperId: string,
    code: string,
    tx?: Prisma.TransactionClient,
  ) => Promise<Delivery | null>;
  /**
   * Serialises the writers of one (company, shipper, order) until `tx` ends.
   *
   * The order pair has no unique index on purpose — two manual deliveries
   * with the same order code can be legitimate (ADR 0006) — so the import's
   * "is this order already here?" is only a guarantee while nobody else can
   * insert the same order between the question and the insert. A
   * transaction-scoped advisory lock gives exactly that, and different orders
   * never wait on each other.
   */
  lockOrderIdentity: (
    businessId: string,
    shipperId: string,
    code: string,
    tx: Prisma.TransactionClient,
  ) => Promise<void>;

  /**
   * The operation, one batch at a time.
   *
   * A generator rather than a list, because an export is the one screen where
   * a company with five million deliveries asks for all of them: the
   * difference between a cursor loop and a `findMany` is the difference
   * between a download and a dead replica.
   */
  /** The listing's rows (same `where` as the screen, decision 5.8), in batches. */
  streamDeliveriesForExport: (
    filters: DeliveryListFilters,
  ) => AsyncGenerator<Record<string, unknown>>;

  /** The occurrence feed's rows (same `where` as its screen), in batches. */
  streamOccurrencesForExport: (
    filters: OccurrenceFeedFilters,
  ) => AsyncGenerator<Record<string, unknown>>;

  countDeliveriesReferencing: (reference: {
    driverId?: string;
    vehicleId?: string;
  }) => Promise<number>;

  createDeliveryEvent: (
    eventData: CreateDeliveryEventProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<void>;
  /**
   * PROOF event + DELIVERED stamp in a single transaction, and only while the
   * delivery still holds `expectedStatus`. Throws DeliveryStatusConflictError
   * (writing neither) when it moved in the meantime.
   *
   * Takes the caller's transaction when there is one, so the route stop this
   * proof resolves commits with it. Opens its own otherwise — the two writes
   * here were never allowed to land apart.
   *
   * In the same write, every occurrence of the delivery still PENDING the
   * tower's authorization becomes SUPERSEDED (decision 6.3): the proof won,
   * and a later approval must not fail a delivered delivery.
   */
  /** Resolves to the requests it superseded (decision 6.3), by occurrence id. */
  registerDeliveryProof: (
    eventData: CreateDeliveryEventProps,
    expectedStatus: DeliveryStatus,
    tx?: Prisma.TransactionClient,
  ) => Promise<string[]>;
}

export {
  IDeliveryRepository,
  DeliveryStatusPatch,
  DeliveryAssignmentPatch,
  type OperationBacklog,
};
