import type { Prisma } from "@prisma/client";

import type { InMemoryDeliveryRepository } from "./in-memory-delivery-repository";
import type { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import type { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type {
  DecideAuthorizationInput,
  EscalationClaim,
  IOccurrenceAuthorizationRepository,
  OccurrenceForDecision,
  PendingAuthorizationRow,
} from "../IOccurrence-authorization-repository";

import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import { authorizationRequestIsLive } from "../../usecases/authorize-occurrence/authorization-liveness";

type StoredOccurrence = InMemoryDeliveryRepository["occurrences"][number];

/**
 * The Prisma repository's semantics over the other twins' arrays: the
 * occurrences live in the delivery twin (one store, as one table), the type
 * and the people in their own twins. Same tenant scoping, same "PENDING
 * only" condition, same order (created_at, id), same once-only escalation,
 * and the same liveness rule — the function the SQL transcribes.
 */
class InMemoryOccurrenceAuthorizationRepository
  implements IOccurrenceAuthorizationRepository
{
  constructor(
    private readonly deliveries: InMemoryDeliveryRepository,
    private readonly types: InMemoryOccurrenceTypeRepository,
    private readonly users: InMemoryUserRepository,
  ) {}

  private businessOf(occurrence: StoredOccurrence): string | undefined {
    return this.deliveries.deliveries.find(
      (delivery) => delivery.id === occurrence.deliveryId,
    )?.businessId;
  }

  private person(userId: string | null | undefined) {
    if (!userId) return null;

    const user = this.users.user.find((entry) => entry.id === userId);

    return user
      ? { id: user.id, name: user.name, driverId: user.driverId ?? null }
      : null;
  }

  private toDecision(occurrence: StoredOccurrence): OccurrenceForDecision {
    const type = this.types.occurrenceTypes.find(
      (entry) => entry.id === occurrence.occurrenceTypeId,
    );

    const reporter = this.person(occurrence.reportedById) ?? {
      id: occurrence.reportedById,
      name: "Usuário",
      driverId: null,
    };

    const decider = this.person(occurrence.authorizedById);

    return {
      id: occurrence.id,
      businessId: this.businessOf(occurrence)!,
      deliveryId: occurrence.deliveryId,
      occurrenceTypeId: occurrence.occurrenceTypeId,
      reportedById: occurrence.reportedById,
      description: occurrence.description ?? null,
      latitude: occurrence.latitude ?? null,
      longitude: occurrence.longitude ?? null,
      photos: occurrence.photos ?? [],
      form_answers: occurrence.form_answers ?? null,
      form_version: occurrence.form_version ?? null,
      authorization_status: occurrence.authorization_status ?? "NOT_REQUIRED",
      authorizedById: occurrence.authorizedById ?? null,
      authorized_at: occurrence.authorized_at ?? null,
      authorization_note: occurrence.authorization_note ?? null,
      escalated_at: occurrence.escalated_at ?? null,
      occurred_at: occurrence.occurred_at ?? null,
      created_at: occurrence.created_at,
      category: occurrence.category ?? "NOT_DELIVERED",
      receipt_photo: occurrence.receipt_photo ?? null,
      signature: occurrence.signature ?? null,
      received_by: occurrence.received_by ?? null,
      occurrenceType: {
        id: occurrence.occurrenceTypeId,
        name: type?.name ?? "Tipo de ocorrência",
        blocks_delivery: type?.blocks_delivery === true,
        requires_authorization: type?.requires_authorization === true,
        form_fields: type?.form_fields ?? null,
      },
      reportedBy: reporter,
      authorizedBy: decider ? { id: decider.id, name: decider.name } : null,
    };
  }

  private oldestFirst(a: StoredOccurrence, b: StoredOccurrence): number {
    return (
      a.created_at.getTime() - b.created_at.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  }

  private isLive(occurrence: StoredOccurrence): boolean {
    return this.liveness(occurrence) === true;
  }

  /**
   * ATTEMPT_JOINS + ATTEMPT_IS_LIVE of the Prisma repository. Null when the
   * inner joins drop the row (no delivery or reporter): then it is neither
   * live nor stale, as in SQL.
   */
  private liveness(occurrence: StoredOccurrence): boolean | null {
    const delivery = this.deliveries.deliveries.find(
      (entry) => entry.id === occurrence.deliveryId,
    );

    const reporter = this.person(occurrence.reportedById);

    if (!delivery || !reporter) return null;

    const anchorEvent = this.deliveries.events
      .filter(
        (event) =>
          event.occurrenceId === occurrence.id && event.type === "OCCURRENCE",
      )
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())[0];

    const openStop = this.deliveries.routeStops
      .filter(
        (stop) =>
          stop.deliveryId === delivery.id &&
          stop.routeId &&
          (stop.status === "PENDING" || stop.status === "ARRIVED"),
      )
      .sort(
        (a, b) =>
          (b.created_at?.getTime() ?? 0) - (a.created_at?.getTime() ?? 0),
      )[0];

    const statusChangedSince = this.deliveries.events.some(
      (event) =>
        event.deliveryId === delivery.id &&
        event.type === "STATUS_CHANGE" &&
        event.created_at.getTime() > occurrence.created_at.getTime(),
    );

    return authorizationRequestIsLive(
      {
        reporterDriverId: reporter.driverId,
        routeId: anchorEvent?.routeId ?? null,
        created_at: occurrence.created_at,
      },
      {
        status: delivery.status as DeliveryStatus,
        driverId: delivery.driverId ?? null,
        openStop: openStop
          ? {
              routeId: openStop.routeId!,
              created_at: openStop.created_at ?? new Date(0),
            }
          : null,
        statusChangedSince,
      },
    );
  }

  private findOwn(
    occurrenceId: string,
    businessId: string,
  ): StoredOccurrence | undefined {
    return this.deliveries.occurrences.find(
      (occurrence) =>
        occurrence.id === occurrenceId &&
        this.businessOf(occurrence) === businessId,
    );
  }

  async lockAttempt(
    occurrenceId: string,
    businessId: string,
    _tx: Prisma.TransactionClient,
  ): Promise<{ live: boolean; deliveryStatus: DeliveryStatus } | null> {
    const found = this.findOwn(occurrenceId, businessId);

    if (!found) return null;

    const delivery = this.deliveries.deliveries.find(
      (entry) => entry.id === found.deliveryId,
    );

    if (!delivery) return null;

    return {
      live: this.isLive(found),
      deliveryStatus: delivery.status as DeliveryStatus,
    };
  }

  async lockDeliveryForRequest(
    deliveryId: string,
    businessId: string,
    _tx: Prisma.TransactionClient,
  ): Promise<{ status: DeliveryStatus; driverId: string | null } | null> {
    const delivery = this.deliveries.deliveries.find(
      (entry) => entry.id === deliveryId && entry.businessId === businessId,
    );

    return delivery
      ? {
          status: delivery.status as DeliveryStatus,
          driverId: delivery.driverId ?? null,
        }
      : null;
  }

  async isWaiting(occurrenceId: string, businessId: string): Promise<boolean> {
    const found = this.findOwn(occurrenceId, businessId);

    return Boolean(
      found && found.authorization_status === "PENDING" && this.isLive(found),
    );
  }

  async supersedeStale(
    limit: number,
    at: Date,
    _tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; businessId: string; deliveryId: string }>> {
    const stale = this.deliveries.occurrences
      .filter(
        (occurrence) =>
          occurrence.authorization_status === "PENDING" &&
          this.liveness(occurrence) === false,
      )
      .sort((a, b) => this.oldestFirst(a, b))
      .slice(0, limit);

    return stale.map((occurrence) => {
      occurrence.authorization_status = "SUPERSEDED";
      occurrence.updated_at = at;

      return {
        id: occurrence.id,
        businessId: this.businessOf(occurrence)!,
        deliveryId: occurrence.deliveryId,
      };
    });
  }

  async findForDecision(
    occurrenceId: string,
    businessId: string,
  ): Promise<OccurrenceForDecision | null> {
    const found = this.deliveries.occurrences.find(
      (occurrence) =>
        occurrence.id === occurrenceId &&
        this.businessOf(occurrence) === businessId,
    );

    return found ? this.toDecision(found) : null;
  }

  async decide(
    input: DecideAuthorizationInput,
    _tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const found = this.deliveries.occurrences.find(
      (occurrence) =>
        occurrence.id === input.occurrenceId &&
        this.businessOf(occurrence) === input.businessId &&
        occurrence.authorization_status === "PENDING",
    );

    if (!found) return false;

    found.authorization_status = input.status;
    found.authorizedById = input.authorizedById;
    found.authorized_at = input.at;
    found.authorization_note = input.note;
    found.updated_at = input.at;

    return true;
  }

  async supersede(
    occurrenceId: string,
    businessId: string,
    _tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const found = this.deliveries.occurrences.find(
      (occurrence) =>
        occurrence.id === occurrenceId &&
        this.businessOf(occurrence) === businessId &&
        occurrence.authorization_status === "PENDING",
    );

    if (!found) return false;

    found.authorization_status = "SUPERSEDED";
    found.updated_at = new Date();

    return true;
  }

  async listPending(
    businessId: string,
    limit: number,
  ): Promise<{ rows: PendingAuthorizationRow[]; total: number }> {
    const pending = this.deliveries.occurrences
      .filter(
        (occurrence) =>
          occurrence.authorization_status === "PENDING" &&
          this.businessOf(occurrence) === businessId &&
          this.isLive(occurrence),
      )
      .sort((a, b) => this.oldestFirst(a, b));

    const rows = pending.slice(0, limit).map((occurrence) => {
      const delivery = this.deliveries.deliveries.find(
        (entry) => entry.id === occurrence.deliveryId,
      )!;

      const driver = delivery.driverId
        ? this.deliveries.driverDirectory.get(delivery.driverId)
        : undefined;

      return {
        ...this.toDecision(occurrence),
        delivery: {
          id: delivery.id!,
          code: delivery.code ?? null,
          invoice_number: delivery.invoice_number ?? null,
          recipient_name: delivery.recipient_name,
          street: delivery.street,
          address_number: delivery.address_number ?? null,
          neighborhood: delivery.neighborhood ?? null,
          city: delivery.city,
          uf: delivery.uf,
          status: delivery.status!,
          driver:
            delivery.driverId && driver
              ? { id: delivery.driverId, name: driver.name }
              : null,
        },
      };
    });

    return { rows, total: pending.length };
  }

  async claimDueEscalations(
    cutoff: Date,
    limit: number,
    at: Date,
    _tx: Prisma.TransactionClient,
  ): Promise<EscalationClaim[]> {
    const due = this.deliveries.occurrences
      .filter(
        (occurrence) =>
          occurrence.authorization_status === "PENDING" &&
          !occurrence.escalated_at &&
          occurrence.created_at.getTime() <= cutoff.getTime() &&
          this.isLive(occurrence),
      )
      .sort((a, b) => this.oldestFirst(a, b))
      .slice(0, limit);

    return due.map((occurrence) => {
      occurrence.escalated_at = at;
      occurrence.updated_at = at;

      const decision = this.toDecision(occurrence);
      const delivery = this.deliveries.deliveries.find(
        (entry) => entry.id === occurrence.deliveryId,
      );

      return {
        id: occurrence.id,
        businessId: decision.businessId,
        deliveryId: occurrence.deliveryId,
        created_at: occurrence.created_at,
        description: decision.description,
        photosCount: decision.photos.length,
        form_answers: decision.form_answers,
        occurrenceTypeName: decision.occurrenceType.name,
        blocksDelivery: decision.occurrenceType.blocks_delivery,
        formFields: decision.occurrenceType.form_fields,
        reporterName: decision.reportedBy.name,
        reporterIsDriver: decision.reportedBy.driverId !== null,
        recipientName: delivery?.recipient_name ?? "",
        category: decision.category,
      };
    });
  }
}

export { InMemoryOccurrenceAuthorizationRepository };
