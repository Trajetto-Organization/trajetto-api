import { Prisma } from "@prisma/client";

import { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import {
  Delivery,
  CreateDeliveryProps,
  UpdateDeliveryProps,
  ListDeliveriesProps,
  ListDeliveriesResult,
  CreateOccurrenceProps,
  CreateDeliveryEventProps,
  DeliveryEventRecord,
  ListOccurrencesProps,
  ListOccurrencesResult,
  OperationSummary,
} from "../dtos/delivery-dto";

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

interface IDeliveryRepository {
  createDelivery: (
    deliveryData: CreateDeliveryProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<Delivery>;
  listDeliveries: (props: ListDeliveriesProps) => Promise<ListDeliveriesResult>;
  findDeliveryById: (deliveryId: string) => Promise<Delivery | null>;
  countDeliveriesByStatus: (
    businessId: string,
    driverId?: string,
  ) => Promise<Record<string, number>>;
  findDeliveryDetailById: (deliveryId: string) => Promise<unknown | null>;
  findDeliveryByInvoiceKey: (
    businessId: string,
    invoiceKey: string,
  ) => Promise<Delivery | null>;
  updateDelivery: (
    deliveryId: string,
    deliveryData: UpdateDeliveryProps,
  ) => Promise<Delivery>;
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
  createOccurrence: (
    occurrenceData: CreateOccurrenceProps,
    tx?: Prisma.TransactionClient,
  ) => Promise<void>;
  findOccurrenceBySubmissionId: (
    clientSubmissionId: string,
  ) => Promise<{ id: string } | null>;
  /** The manager's cross-delivery occurrence feed. */
  listOccurrences: (props: ListOccurrencesProps) => Promise<ListOccurrencesResult>;
  /** Whole-company numbers for the stats cards, ignoring page filters. */
  countOccurrencesSummary: (
    businessId: string,
    driverId?: string,
  ) => Promise<{ total: number; blocking: number }>;
  /** Aggregates behind the monitoring panel: totals + per-driver board. */
  operationSummary: (businessId: string) => Promise<OperationSummary>;
  /** The driver's working list: own PENDING (designated) + IN_TRANSIT. */
  listDriverDeliveries: (
    businessId: string,
    driverId: string,
  ) => Promise<unknown[]>;
  /** How many of the driver's deliveries are still waiting to leave. */
  countPendingForDriver: (
    businessId: string,
    driverId: string,
  ) => Promise<number>;
  /** PENDING -> IN_TRANSIT for the driver's batch; returns how many moved. */
  startDriverRoute: (businessId: string, driverId: string) => Promise<number>;
  findEventBySubmissionId: (
    clientSubmissionId: string,
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
   */
  findDeliveryByShipperAndCode: (
    businessId: string,
    shipperId: string,
    code: string,
  ) => Promise<Delivery | null>;

  /**
   * The operation, one batch at a time.
   *
   * A generator rather than a list, because an export is the one screen where
   * a company with five million deliveries asks for all of them: the
   * difference between a cursor loop and a `findMany` is the difference
   * between a download and a dead replica.
   */
  streamDeliveriesForExport: (props: {
    businessId: string;
    driverId?: string;
    search?: string;
    status?: string;
  }) => AsyncGenerator<Record<string, unknown>>;

  streamOccurrencesForExport: (props: {
    businessId: string;
    driverId?: string;
    search?: string;
  }) => AsyncGenerator<Record<string, unknown>>;

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
   */
  registerDeliveryProof: (
    eventData: CreateDeliveryEventProps,
    expectedStatus: DeliveryStatus,
    tx?: Prisma.TransactionClient,
  ) => Promise<void>;
}

export { IDeliveryRepository, DeliveryStatusPatch, DeliveryAssignmentPatch };
