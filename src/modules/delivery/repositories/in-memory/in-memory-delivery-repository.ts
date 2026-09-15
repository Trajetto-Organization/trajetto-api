import { v7 as uuidV7 } from "uuid";
import {
  IDeliveryRepository,
  DeliveryStatusPatch,
  DeliveryAssignmentPatch,
} from "../IDelivery-repository";

import {
  DeliveryAssignmentConflictError,
  DeliveryStatusConflictError,
} from "../../usecases/errors/delivery-errors";

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
  DriverOperationRow,
  OperationSummary,
} from "../../dtos/delivery-dto";

class InMemoryDeliveryRepository implements IDeliveryRepository {
  public deliveries: Delivery[] = [];
  public occurrences: Array<
    CreateOccurrenceProps & { id: string; created_at: Date }
  > = [];
  public events: Array<CreateDeliveryEventProps & { id: string }> = [];

  /**
   * Test seams: the in-memory store has no occurrence-type or driver
   * tables, so panel tests seed these maps directly.
   */
  public occurrenceTypeBlocking = new Map<string, boolean>();
  public driverDirectory = new Map<string, { name: string; cnh: string }>();

  /**
   * The route stops, as the real `where` sees them.
   *
   * The batch departure must not touch a delivery that belongs to a route —
   * that one leaves with its route. In Postgres that is a relation filter; here
   * a test hands over the route fake's own array, so the two fakes see one set
   * of stops. Empty by default, which is the truth for every test that has no
   * routes at all.
   */
  public routeStops: Array<{ deliveryId: string; status: string }> = [];

  private onAnOpenStop(deliveryId?: string): boolean {
    return this.routeStops.some(
      (stop) =>
        stop.deliveryId === deliveryId &&
        (stop.status === "PENDING" || stop.status === "ARRIVED"),
    );
  }

  async createDelivery(deliveryData: CreateDeliveryProps): Promise<Delivery> {
    const { items: _items, ...delivery } = deliveryData;

    const newDelivery: Delivery = {
      id: uuidV7(),
      ...delivery,
      status: "PENDING",
    };

    this.deliveries.push(newDelivery);
    return newDelivery;
  }

  async listDeliveries({
    page,
    pageSize,
    businessId,
    status,
    shipperId,
    driverId,
    search,
  }: ListDeliveriesProps): Promise<ListDeliveriesResult> {
    let filtered = this.deliveries.filter(
      (d) =>
        d.businessId === businessId &&
        (!status || d.status === status) &&
        (!shipperId || d.shipperId === shipperId) &&
        (!driverId || d.driverId === driverId),
    );

    if (search) {
      const term = search.trim().toLowerCase();
      filtered = filtered.filter((d) =>
        [
          d.recipient_name,
          d.code ?? "",
          d.invoice_key ?? "",
          d.invoice_number ?? "",
          d.city,
        ].some((value) => value.toLowerCase().includes(term)),
      );
    }

    const skip = (page - 1) * pageSize;

    return {
      data: filtered.slice(skip, skip + pageSize),
      total: filtered.length,
    };
  }

  async countDeliveriesByStatus(
    businessId: string,
    driverId?: string,
  ): Promise<Record<string, number>> {
    return this.deliveries
      .filter(
        (d) =>
          d.businessId === businessId && (!driverId || d.driverId === driverId),
      )
      .reduce<Record<string, number>>((acc, delivery) => {
        acc[delivery.status] = (acc[delivery.status] ?? 0) + 1;
        return acc;
      }, {});
  }

  async findDeliveryById(deliveryId: string): Promise<Delivery | null> {
    return this.deliveries.find((d) => d.id === deliveryId) ?? null;
  }

  async findDeliveryDetailById(deliveryId: string): Promise<unknown | null> {
    return this.findDeliveryById(deliveryId);
  }

  async findDeliveryByInvoiceKey(
    businessId: string,
    invoiceKey: string,
  ): Promise<Delivery | null> {
    return (
      this.deliveries.find(
        (d) => d.businessId === businessId && d.invoice_key === invoiceKey,
      ) ?? null
    );
  }

  async updateDelivery(
    deliveryId: string,
    deliveryData: UpdateDeliveryProps,
  ): Promise<Delivery> {
    const index = this.deliveries.findIndex((d) => d.id === deliveryId);

    const filteredData = Object.fromEntries(
      Object.entries(deliveryData).filter(([, value]) => value !== undefined),
    );

    this.deliveries[index] = { ...this.deliveries[index], ...filteredData };
    return this.deliveries[index];
  }

  async updateDeliveryStatus(
    deliveryId: string,
    patch: DeliveryStatusPatch,
  ): Promise<Delivery> {
    // Mirrors the status filter in the Prisma `where`. Without it the fake
    // would accept writes the real repository refuses, and a test proving the
    // concurrency guard would be proving nothing.
    const index = this.deliveries.findIndex(
      (d) => d.id === deliveryId && d.status === patch.expectedStatus,
    );

    if (index === -1) {
      throw new DeliveryStatusConflictError();
    }

    this.deliveries[index] = {
      ...this.deliveries[index],
      status: patch.status,
      ...(patch.delivered_at !== undefined && {
        delivered_at: patch.delivered_at,
      }),
      ...(patch.received_by !== undefined && {
        received_by: patch.received_by,
      }),
    };

    return this.deliveries[index];
  }

  async findDeliveriesByIds(deliveryIds: string[]): Promise<Delivery[]> {
    return this.deliveries.filter((delivery) =>
      deliveryIds.includes(delivery.id ?? ""),
    );
  }

  async assignDeliveries(
    deliveryIds: string[],
    assignment: DeliveryAssignmentPatch,
  ): Promise<void> {
    const targets = this.deliveries.filter((delivery) =>
      deliveryIds.includes(delivery.id ?? ""),
    );

    // Mirrors the transaction in the Prisma repository: nothing is written
    // unless every selected delivery is still PENDING.
    const allPending =
      targets.length === deliveryIds.length &&
      targets.every((delivery) => delivery.status === "PENDING");

    if (!allPending) {
      throw new DeliveryAssignmentConflictError();
    }

    for (const delivery of targets) {
      delivery.driverId = assignment.driverId;
      delivery.vehicleId = assignment.vehicleId;
    }
  }

  async createOccurrence(
    occurrenceData: CreateOccurrenceProps,
  ): Promise<void> {
    this.occurrences.push({
      ...occurrenceData,
      id: uuidV7(),
      created_at: new Date(),
    });
  }

  async findOccurrenceBySubmissionId(
    clientSubmissionId: string,
  ): Promise<{ id: string } | null> {
    const found = this.occurrences.find(
      (occurrence) => occurrence.client_submission_id === clientSubmissionId,
    );

    return found ? { id: found.id } : null;
  }

  async listOccurrences({
    page,
    pageSize,
    businessId,
    blocksDelivery,
    occurrenceTypeId,
    driverId,
    search,
  }: ListOccurrencesProps): Promise<ListOccurrencesResult> {
    const deliveriesById = new Map(
      this.deliveries.map((delivery) => [delivery.id, delivery]),
    );

    const filtered = this.occurrences.filter((occurrence) => {
      const delivery = deliveriesById.get(occurrence.deliveryId);

      if (!delivery || delivery.businessId !== businessId) return false;
      if (driverId && delivery.driverId !== driverId) return false;

      if (
        occurrenceTypeId &&
        occurrence.occurrenceTypeId !== occurrenceTypeId
      ) {
        return false;
      }

      if (
        blocksDelivery !== undefined &&
        this.occurrenceTypeBlocking.get(occurrence.occurrenceTypeId) !==
          blocksDelivery
      ) {
        return false;
      }

      if (search) {
        const term = search.trim().toLowerCase();

        const matches = [
          occurrence.id,
          occurrence.deliveryId,
          delivery.recipient_name,
        ].some((value) => value.toLowerCase().includes(term));

        if (!matches) return false;
      }

      return true;
    });

    const skip = (page - 1) * pageSize;

    return {
      data: filtered.slice(skip, skip + pageSize),
      total: filtered.length,
      currentPage: page,
      pageSize,
      totalPages: Math.ceil(filtered.length / pageSize),
    };
  }

  async countOccurrencesSummary(
    businessId: string,
    driverId?: string,
  ): Promise<{ total: number; blocking: number }> {
    const deliveriesById = new Map(
      this.deliveries.map((delivery) => [delivery.id, delivery]),
    );

    const scoped = this.occurrences.filter((occurrence) => {
      const delivery = deliveriesById.get(occurrence.deliveryId);
      if (!delivery || delivery.businessId !== businessId) return false;
      if (driverId && delivery.driverId !== driverId) return false;
      return true;
    });

    return {
      total: scoped.length,
      blocking: scoped.filter(
        (occurrence) =>
          this.occurrenceTypeBlocking.get(occurrence.occurrenceTypeId) ===
          true,
      ).length,
    };
  }

  async operationSummary(businessId: string): Promise<OperationSummary> {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const isToday = (value?: Date | string | null): boolean =>
      Boolean(value) && new Date(value as Date | string) >= startOfToday;

    const rows = new Map<string, DriverOperationRow>();

    const rowFor = (driverId: string): DriverOperationRow => {
      const existing = rows.get(driverId);
      if (existing) return existing;

      const directory = this.driverDirectory.get(driverId);

      const created: DriverOperationRow = {
        driverId,
        driverName: directory?.name ?? "",
        cnh: directory?.cnh ?? "",
        designated: 0,
        inRoute: 0,
        deliveredToday: 0,
        failedToday: 0,
      };

      rows.set(driverId, created);
      return created;
    };

    let unassigned = 0;
    let deliveredToday = 0;
    let failedToday = 0;

    for (const delivery of this.deliveries) {
      if (delivery.businessId !== businessId) continue;

      if (delivery.status === "PENDING" && !delivery.driverId) {
        unassigned += 1;
        continue;
      }

      if (delivery.driverId) {
        const row = rowFor(delivery.driverId);
        if (delivery.status === "PENDING") row.designated += 1;
        if (delivery.status === "IN_TRANSIT") row.inRoute += 1;
        if (delivery.status === "DELIVERED" && isToday(delivery.delivered_at)) {
          row.deliveredToday += 1;
        }
        if (delivery.status === "FAILED" && isToday(delivery.updated_at)) {
          row.failedToday += 1;
        }
      }

      if (delivery.status === "DELIVERED" && isToday(delivery.delivered_at)) {
        deliveredToday += 1;
      }
      if (delivery.status === "FAILED" && isToday(delivery.updated_at)) {
        failedToday += 1;
      }
    }

    const deliveriesById = new Map(
      this.deliveries.map((delivery) => [delivery.id, delivery]),
    );

    const occurrencesToday = this.occurrences.filter((occurrence) => {
      const delivery = deliveriesById.get(occurrence.deliveryId);
      return (
        delivery?.businessId === businessId && isToday(occurrence.created_at)
      );
    }).length;

    const drivers = [...rows.values()]
      .filter(
        (row) =>
          row.designated + row.inRoute + row.deliveredToday + row.failedToday >
          0,
      )
      .sort(
        (a, b) =>
          b.inRoute - a.inRoute || a.driverName.localeCompare(b.driverName),
      );

    return {
      totals: {
        unassigned,
        designated: drivers.reduce((sum, row) => sum + row.designated, 0),
        inRoute: drivers.reduce((sum, row) => sum + row.inRoute, 0),
        deliveredToday,
        failedToday,
        occurrencesToday,
      },
      drivers,
    };
  }

  async listDriverDeliveries(
    businessId: string,
    driverId: string,
  ): Promise<unknown[]> {
    return this.deliveries
      .filter(
        (delivery) =>
          delivery.businessId === businessId &&
          delivery.driverId === driverId &&
          (delivery.status === "PENDING" || delivery.status === "IN_TRANSIT"),
      )
      .map((delivery) => ({
        ...delivery,

        // The open stop rides along, as the real include does: the app needs
        // the dispatcher's order and this is the payload it caches. At most
        // one — the partial unique index allows a delivery exactly one.
        stops: this.routeStops.filter(
          (stop) =>
            stop.deliveryId === delivery.id &&
            (stop.status === "PENDING" || stop.status === "ARRIVED"),
        ),
      }));
  }

  async countPendingForDriver(
    businessId: string,
    driverId: string,
  ): Promise<number> {
    return this.deliveries.filter(
      (delivery) =>
        delivery.businessId === businessId &&
        delivery.driverId === driverId &&
        delivery.status === "PENDING" &&
        !this.onAnOpenStop(delivery.id),
    ).length;
  }

  async startDriverRoute(
    businessId: string,
    driverId: string,
  ): Promise<number> {
    const pending = this.deliveries.filter(
      (delivery) =>
        delivery.businessId === businessId &&
        delivery.driverId === driverId &&
        delivery.status === "PENDING" &&
        // A delivery on a route leaves with that route. Without this the old
        // batch departure would drag an unreleased plan onto the street.
        !this.onAnOpenStop(delivery.id),
    );

    for (const delivery of pending) {
      delivery.status = "IN_TRANSIT";
    }

    return pending.length;
  }

  async findEventBySubmissionId(
    clientSubmissionId: string,
  ): Promise<DeliveryEventRecord | null> {
    const found = this.events.find(
      (event) => event.client_submission_id === clientSubmissionId,
    );

    if (!found) return null;

    return {
      id: found.id,
      type: found.type,
      deliveryId: found.deliveryId,
      client_submission_id: found.client_submission_id,
    };
  }

  async countDeliveriesReferencing(reference: {
    driverId?: string;
    vehicleId?: string;
  }): Promise<number> {
    return this.deliveries.filter(
      (delivery) =>
        (!reference.driverId || delivery.driverId === reference.driverId) &&
        (!reference.vehicleId || delivery.vehicleId === reference.vehicleId),
    ).length;
  }

  async createDeliveryEvent(
    eventData: CreateDeliveryEventProps,
  ): Promise<void> {
    this.events.push({ ...eventData, id: uuidV7() });
  }

  async registerDeliveryProof(
    eventData: CreateDeliveryEventProps,
    expectedStatus: DeliveryStatus,
  ): Promise<void> {
    // Mirrors the Prisma transaction: event and DELIVERED stamp together, and
    // only while the delivery still holds the status the caller validated.
    // The conflict is raised BEFORE the event is pushed, so the fake rolls
    // back the same way the real transaction does.
    const delivery = this.deliveries.find(
      (entry) => entry.id === eventData.deliveryId,
    );

    if (!delivery || delivery.status !== expectedStatus) {
      throw new DeliveryStatusConflictError();
    }

    this.events.push({ ...eventData, type: "PROOF", id: uuidV7() });

    delivery.status = "DELIVERED";
    delivery.delivered_at = new Date();
    delivery.received_by = eventData.received_by ?? null;
  }
}

export { InMemoryDeliveryRepository };
