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
  delivered_at?: Date | null;
  received_by?: string | null;
}

interface DeliveryAssignmentPatch {
  driverId: string;
  /** null clears the vehicle — each assignment fully defines the pair. */
  vehicleId: string | null;
}

interface IDeliveryRepository {
  createDelivery: (deliveryData: CreateDeliveryProps) => Promise<Delivery>;
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
  createDeliveryEvent: (eventData: CreateDeliveryEventProps) => Promise<void>;
  /** PROOF event + DELIVERED stamp in a single transaction. */
  registerDeliveryProof: (
    eventData: CreateDeliveryEventProps,
  ) => Promise<void>;
}

export { IDeliveryRepository, DeliveryStatusPatch, DeliveryAssignmentPatch };
