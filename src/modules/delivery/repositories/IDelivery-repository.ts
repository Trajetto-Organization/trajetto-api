import { Prisma } from "@prisma/client";

import { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import type { OperationDay } from "@/modules/route/repositories/IOperation-day-repository";
import type { ReusedAddressPoint } from "@/shared/delivery/geocoding/address-point-reuse";
import {
  Delivery,
  DeliveryItemInput,
  CreateDeliveryProps,
  UpdateDeliveryProps,
  ListDeliveriesProps,
  ListDeliveriesPage,
  CreateOccurrenceProps,
  CreateDeliveryEventProps,
  DeliveryEventRecord,
  DepartureHook,
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
  /**
   * The row with its address key (address-key.ts) and its point: the one
   * given (MANUAL) or, without one, the point another delivery of the
   * company has at the same address (address-point-reuse.ts), read in the
   * same transaction. The one door of the panel, the NF-e XML, the
   * spreadsheet and the public API.
   */
  createDelivery: (
    deliveryData: CreateDeliveryProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<Delivery>;
  /**
   * The point another delivery of the company has at this address key, as
   * the columns a delivery takes it with (pickReusablePoint: MANUAL first,
   * then the most recent; never another company's), with the root it came
   * from (geo_copied_from; a copy whose root dropped the point lends
   * nothing); null when none qualifies. `excludeDeliveryId`: the delivery
   * being edited, never recorded as its own root.
   */
  findReusablePoint: (
    businessId: string,
    addressKey: string,
    excludeDeliveryId?: string | null,
    tx?: Prisma.TransactionClient,
  ) => Promise<ReusedAddressPoint | null>;
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
    /**
     * The caller's transaction, when it has one: an edit of a delivery on a
     * route commits with the route's lock and plan version (K9).
     */
    tx?: Prisma.TransactionClient,
  ) => Promise<Delivery>;
  /**
   * The delivery's item list as stored (quantity 1 and empty unit NULL),
   * in insertion order. An edit compares the list it got against it (K9).
   */
  findDeliveryItems: (deliveryId: string) => Promise<DeliveryItemInput[]>;
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
    /**
     * The delivery the key was spent on: the same key on another delivery
     * is a reused key (409), never a replay (K13).
     */
    deliveryId: string;
    /** A replay answers with where the first submission stands (6.3). */
    authorization_status: OccurrenceAuthorizationStatus;
    /** Decision 14.3: a delivered replay also answers the delivery's status. */
    category: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";
  } | null>;
  /**
   * The manager's cross-delivery occurrence feed: one page in the requested
   * order, plus the per-type counts its cards, filters and pager come from.
   */
  listOccurrences: (
    props: ListOccurrencesProps,
  ) => Promise<ListOccurrencesResult>;
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
   * `createdUpTo`: only deliveries created at or before it (the tap). Each
   * one that moved gets its STATUS_CHANGE line, and `onStarted` gets them
   * inside the same transaction (its webhooks), F2-06.
   */
  startDriverRoute: (
    businessId: string,
    driverId: string,
    createdUpTo?: Date,
    onStarted?: DepartureHook,
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
   * Which of these NF-e access keys the company already has: the import's
   * duplicate check for a batch of rows in one read (plano-escala F3-23c),
   * the same answer findDeliveryByInvoiceKey gives one at a time.
   */
  findExistingInvoiceKeys: (
    businessId: string,
    invoiceKeys: readonly string[],
  ) => Promise<Set<string>>;

  /**
   * Which of these order numbers the company already has for the shipper
   * (plano-escala F3-23c), as findDeliveryByShipperAndCode answers one at a
   * time; with `tx`, inside the caller's transaction (after
   * lockOrderIdentity).
   */
  findExistingOrderCodes: (
    businessId: string,
    shipperId: string,
    codes: readonly string[],
    tx?: Prisma.TransactionClient,
  ) => Promise<Set<string>>;

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
    /**
     * A late proof (K7, decision D27) of a delivery the driver lost after
     * the tap: the driver and vehicle that delivered it go back on the row,
     * as a resolved delivery keeps who resolved it.
     */
    owner?: { driverId: string; vehicleId: string | null },
  ) => Promise<string[]>;
}

export {
  IDeliveryRepository,
  DeliveryStatusPatch,
  DeliveryAssignmentPatch,
  type OperationBacklog,
};
