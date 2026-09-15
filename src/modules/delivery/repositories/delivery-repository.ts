import { Prisma } from "@prisma/client";

import {
  IDeliveryRepository,
  DeliveryStatusPatch,
  DeliveryAssignmentPatch,
} from "./IDelivery-repository";

import {
  DeliveryAssignmentConflictError,
  DeliveryStatusConflictError,
} from "../usecases/errors/delivery-errors";

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
} from "../dtos/delivery-dto";

import database from "@/../infra/database";

// Every read surfaces the shipper name and the assignment context — the
// panels never fetch relations in a second round-trip.
const listInclude = {
  shipper: { select: { id: true, name: true } },
  driver: { select: { id: true, name: true, cnh: true } },
  vehicle: { select: { id: true, license_plate: true } },
} as const;

/**
 * The batch departure only ever touches deliveries that are NOT on a route.
 *
 * A delivery sitting on a PLANNED route already carries the driver's id — that
 * is the route's shadow, written the moment the dispatcher built it. Without
 * this filter one tap on the app's old "iniciar rota" would drag tomorrow's
 * plan onto the street, a route the dispatcher never released, and the route
 * itself would still read PLANNED with its load already in transit.
 *
 * A delivery that belongs to a route leaves WITH that route, through the
 * route's own departure. This is what keeps the two dispatch models — batch
 * assignment and routes — from writing over each other while both exist.
 */
const NOT_ON_A_ROUTE: Prisma.DeliveryWhereInput = {
  stops: { none: { status: { in: ["PENDING", "ARRIVED"] } } },
};

class DeliveryRepository implements IDeliveryRepository {
  constructor(private prisma = database) {}

  async createDelivery(deliveryData: CreateDeliveryProps): Promise<Delivery> {
    const { items, ...delivery } = deliveryData;

    const deliveryCreated = await this.prisma.delivery.create({
      data: {
        ...delivery,
        code: delivery.code || null,
        invoice_key: delivery.invoice_key || null,
        invoice_number: delivery.invoice_number || null,
        ...(items &&
          items.length > 0 && {
            items: {
              create: items.map((item) => ({
                description: item.description,
                quantity: item.quantity ?? 1,
                unit: item.unit || null,
                unit_value: item.unit_value ?? null,
              })),
            },
          }),
      },
    });

    return deliveryCreated as Delivery;
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
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim() : "";

    const whereCondition = {
      businessId,
      ...(status && { status }),
      ...(shipperId && { shipperId }),
      ...(driverId && { driverId }),
      ...(normalizedSearch && {
        OR: [
          { id: { contains: normalizedSearch, mode: "insensitive" as const } },
          {
            recipient_name: {
              contains: normalizedSearch,
              mode: "insensitive" as const,
            },
          },
          { code: { contains: normalizedSearch, mode: "insensitive" as const } },
          {
            invoice_key: {
              contains: normalizedSearch,
              mode: "insensitive" as const,
            },
          },
          {
            invoice_number: {
              contains: normalizedSearch,
              mode: "insensitive" as const,
            },
          },
          { city: { contains: normalizedSearch, mode: "insensitive" as const } },
          // Homonymous drivers are told apart by CNH, so the dispatcher can
          // search deliveries by either.
          {
            driver: {
              name: {
                contains: normalizedSearch,
                mode: "insensitive" as const,
              },
            },
          },
          {
            driver: {
              cnh: {
                contains: normalizedSearch,
                mode: "insensitive" as const,
              },
            },
          },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.delivery.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        include: listInclude,
        orderBy: { created_at: "desc" },
      }),
      this.prisma.delivery.count({ where: whereCondition }),
    ]);

    return { data: data as Delivery[], total };
  }

  // Aggregate over the whole company, not the page being shown: a panel
  // that says "3 em rota" while there are 200 deliveries is worse than no
  // panel at all.
  async countDeliveriesByStatus(
    businessId: string,
    driverId?: string,
  ): Promise<Record<string, number>> {
    const grouped = await this.prisma.delivery.groupBy({
      by: ["status"],
      where: { businessId, ...(driverId && { driverId }) },
      _count: { _all: true },
    });

    return grouped.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});
  }

  async findDeliveryById(deliveryId: string): Promise<Delivery | null> {
    const found = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
    });

    return found as Delivery | null;
  }

  async findDeliveryDetailById(deliveryId: string): Promise<unknown | null> {
    return this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        ...listInclude,
        items: true,
        // The driver's appointments: arrival and proof marks, newest first.
        events: {
          orderBy: { created_at: "desc" },
          include: { reportedBy: { select: { id: true, name: true } } },
        },
        occurrences: {
          orderBy: { created_at: "desc" },
          include: {
            occurrenceType: {
              select: { id: true, name: true, blocks_delivery: true },
            },
            reportedBy: { select: { id: true, name: true } },
          },
        },
      },
    });
  }

  async findDeliveryByInvoiceKey(
    businessId: string,
    invoiceKey: string,
  ): Promise<Delivery | null> {
    const found = await this.prisma.delivery.findUnique({
      where: {
        businessId_invoice_key: { businessId, invoice_key: invoiceKey },
      },
    });

    return found as Delivery | null;
  }

  async updateDelivery(
    deliveryId: string,
    deliveryData: UpdateDeliveryProps,
  ): Promise<Delivery> {
    const filteredData = Object.fromEntries(
      Object.entries(deliveryData).filter(([, value]) => value !== undefined),
    );

    const updated = await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: filteredData,
    });

    return updated as Delivery;
  }

  /**
   * The status filter rides along in the `where`, the same way it does in
   * `assignDeliveries`: it makes the read the caller validated and the write
   * it authorised one atomic step, instead of two separated by a window that
   * four different screens can drive through.
   *
   * `updateMany` + `count` rather than a filtered `update`, deliberately.
   * Prisma's extended `where` on `update` would do this in one round trip and
   * signal the miss as P2025, but that leans on a semantics this codebase has
   * never exercised, and the failure mode of being wrong is the worst one
   * available: a filter silently ignored, a guard that does nothing, and a
   * green test suite saying otherwise. `updateMany` filters the way every
   * other query here filters. The extra read costs one SELECT on a path that
   * runs a handful of times per delivery.
   */
  async updateDeliveryStatus(
    deliveryId: string,
    patch: DeliveryStatusPatch,
    tx?: Prisma.TransactionClient,
  ): Promise<Delivery> {
    const client = tx ?? this.prisma;

    const moved = await client.delivery.updateMany({
      where: { id: deliveryId, status: patch.expectedStatus },
      data: {
        status: patch.status,
        ...(patch.delivered_at !== undefined && {
          delivered_at: patch.delivered_at,
        }),
        ...(patch.received_by !== undefined && {
          received_by: patch.received_by,
        }),
      },
    });

    if (moved.count === 0) {
      throw new DeliveryStatusConflictError();
    }

    return (await client.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
    })) as Delivery;
  }

  async findDeliveriesByIds(deliveryIds: string[]): Promise<Delivery[]> {
    return this.prisma.delivery.findMany({
      where: { id: { in: deliveryIds } },
    });
  }

  async assignDeliveries(
    deliveryIds: string[],
    assignment: DeliveryAssignmentPatch,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.delivery.updateMany({
        // The status filter re-checks inside the transaction: a delivery
        // that left PENDING between validation and write must sink the
        // whole batch, never slip through half-assigned.
        where: { id: { in: deliveryIds }, status: "PENDING" },
        data: {
          driverId: assignment.driverId,
          vehicleId: assignment.vehicleId,
        },
      });

      if (result.count !== deliveryIds.length) {
        throw new DeliveryAssignmentConflictError();
      }
    });
  }

  async createOccurrence(
    occurrenceData: CreateOccurrenceProps,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await (tx ?? this.prisma).deliveryOccurrence.create({
      data: {
        deliveryId: occurrenceData.deliveryId,
        occurrenceTypeId: occurrenceData.occurrenceTypeId,
        reportedById: occurrenceData.reportedById,
        description: occurrenceData.description || null,
        latitude: occurrenceData.latitude ?? null,
        longitude: occurrenceData.longitude ?? null,
        photos: occurrenceData.photos ?? [],
        client_submission_id: occurrenceData.client_submission_id ?? null,
      },
    });
  }

  async findOccurrenceBySubmissionId(
    clientSubmissionId: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.deliveryOccurrence.findUnique({
      where: { client_submission_id: clientSubmissionId },
      select: { id: true },
    });
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
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim() : "";

    const whereCondition = {
      delivery: {
        businessId,
        ...(driverId && { driverId }),
      },
      ...(occurrenceTypeId && { occurrenceTypeId }),
      ...(blocksDelivery !== undefined && {
        occurrenceType: { blocks_delivery: blocksDelivery },
      }),
      ...(normalizedSearch && {
        OR: [
          // Both ids are copiable from the row menu, so both have to come
          // back when pasted into the search.
          { id: { contains: normalizedSearch, mode: "insensitive" as const } },
          {
            deliveryId: {
              contains: normalizedSearch,
              mode: "insensitive" as const,
            },
          },
          {
            delivery: {
              recipient_name: {
                contains: normalizedSearch,
                mode: "insensitive" as const,
              },
            },
          },
          {
            occurrenceType: {
              name: {
                contains: normalizedSearch,
                mode: "insensitive" as const,
              },
            },
          },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.deliveryOccurrence.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        orderBy: { created_at: "desc" },
        include: {
          occurrenceType: {
            select: {
              id: true,
              name: true,
              blocks_delivery: true,
              requires_photo: true,
            },
          },
          reportedBy: { select: { id: true, name: true } },
          delivery: {
            select: {
              id: true,
              recipient_name: true,
              status: true,
              city: true,
              uf: true,
              code: true,
            },
          },
        },
      }),
      this.prisma.deliveryOccurrence.count({ where: whereCondition }),
    ]);

    return {
      data,
      total,
      currentPage: page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async countOccurrencesSummary(
    businessId: string,
    driverId?: string,
  ): Promise<{ total: number; blocking: number }> {
    const scope = { delivery: { businessId, ...(driverId && { driverId }) } };

    const [total, blocking] = await Promise.all([
      this.prisma.deliveryOccurrence.count({ where: scope }),
      this.prisma.deliveryOccurrence.count({
        where: { ...scope, occurrenceType: { blocks_delivery: true } },
      }),
    ]);

    return { total, blocking };
  }

  async operationSummary(businessId: string): Promise<OperationSummary> {
    // "Today" is the server's midnight — documented approximation; a
    // per-business timezone enters if the operation asks for it.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [
      activeByDriver,
      unassigned,
      deliveredTodayByDriver,
      failedTodayByDriver,
      deliveredToday,
      failedToday,
      occurrencesToday,
    ] = await Promise.all([
      this.prisma.delivery.groupBy({
        by: ["driverId", "status"],
        where: {
          businessId,
          driverId: { not: null },
          status: { in: ["PENDING", "IN_TRANSIT"] },
        },
        _count: { _all: true },
      }),
      this.prisma.delivery.count({
        where: { businessId, status: "PENDING", driverId: null },
      }),
      this.prisma.delivery.groupBy({
        by: ["driverId"],
        where: {
          businessId,
          driverId: { not: null },
          status: "DELIVERED",
          delivered_at: { gte: startOfToday },
        },
        _count: { _all: true },
      }),
      // FAILED can travel back to PENDING on redelivery, so this reads
      // "in failure now, and moved today" — honest approximation.
      this.prisma.delivery.groupBy({
        by: ["driverId"],
        where: {
          businessId,
          driverId: { not: null },
          status: "FAILED",
          updated_at: { gte: startOfToday },
        },
        _count: { _all: true },
      }),
      this.prisma.delivery.count({
        where: {
          businessId,
          status: "DELIVERED",
          delivered_at: { gte: startOfToday },
        },
      }),
      this.prisma.delivery.count({
        where: {
          businessId,
          status: "FAILED",
          updated_at: { gte: startOfToday },
        },
      }),
      this.prisma.deliveryOccurrence.count({
        where: {
          delivery: { businessId },
          created_at: { gte: startOfToday },
        },
      }),
    ]);

    const rows = new Map<string, DriverOperationRow>();

    const rowFor = (driverId: string): DriverOperationRow => {
      const existing = rows.get(driverId);
      if (existing) return existing;

      const created: DriverOperationRow = {
        driverId,
        driverName: "",
        cnh: "",
        designated: 0,
        inRoute: 0,
        deliveredToday: 0,
        failedToday: 0,
      };

      rows.set(driverId, created);
      return created;
    };

    for (const entry of activeByDriver) {
      const row = rowFor(entry.driverId as string);
      if (entry.status === "PENDING") row.designated = entry._count._all;
      if (entry.status === "IN_TRANSIT") row.inRoute = entry._count._all;
    }

    for (const entry of deliveredTodayByDriver) {
      rowFor(entry.driverId as string).deliveredToday = entry._count._all;
    }

    for (const entry of failedTodayByDriver) {
      rowFor(entry.driverId as string).failedToday = entry._count._all;
    }

    const driverIds = [...rows.keys()];

    if (driverIds.length > 0) {
      const driverRecords = await this.prisma.driver.findMany({
        where: { id: { in: driverIds } },
        select: { id: true, name: true, cnh: true },
      });

      for (const driver of driverRecords) {
        const row = rows.get(driver.id);

        if (row) {
          row.driverName = driver.name;
          row.cnh = driver.cnh;
        }
      }
    }

    // Whoever is on the street comes first; ties read alphabetically.
    const drivers = [...rows.values()].sort(
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
    return this.prisma.delivery.findMany({
      where: {
        businessId,
        driverId,
        status: { in: ["PENDING", "IN_TRANSIT"] },
      },
      include: {
        shipper: { select: { id: true, name: true } },
        items: true,

        /**
         * The open stop, when this delivery is on a route.
         *
         * The dispatcher put the addresses in an order, and until now the
         * driver could not see it: the app listed the day by date and
         * creation, which is not the street. One stop at most — the partial
         * unique index allows a delivery exactly one open stop — so the app
         * reads `stops[0]` and sorts by its sequence.
         *
         * Carried in THIS payload rather than fetched separately because this
         * is the one the app caches for seven days offline; a second endpoint
         * would be a second thing to go stale, on a phone with no signal.
         */
        stops: {
          where: { status: { in: ["PENDING", "ARRIVED"] } },
          select: {
            id: true,
            sequence: true,
            status: true,
            route: {
              select: {
                id: true,
                code: true,
                name: true,
                status: true,
              },
            },
          },
        },
      },
      // Unchanged: dated first, then creation order, undated last.
      //
      // Deliberately NOT ordered by the stop's sequence — Prisma cannot order
      // a row by a field of a to-many relation, and the app has to sort
      // anyway: it renders this list from its offline cache, where the order
      // the server chose is long gone. The sequence travels in the payload and
      // the app is what puts the street in order.
      orderBy: [
        { scheduled_date: { sort: "asc", nulls: "last" } },
        { created_at: "asc" },
      ],
    });
  }

  async countPendingForDriver(
    businessId: string,
    driverId: string,
  ): Promise<number> {
    return this.prisma.delivery.count({
      where: { businessId, driverId, status: "PENDING", ...NOT_ON_A_ROUTE },
    });
  }

  async startDriverRoute(
    businessId: string,
    driverId: string,
  ): Promise<number> {
    // Naturally idempotent: a resend finds nothing left to move.
    const result = await this.prisma.delivery.updateMany({
      where: { businessId, driverId, status: "PENDING", ...NOT_ON_A_ROUTE },
      data: { status: "IN_TRANSIT" },
    });

    return result.count;
  }

  async findEventBySubmissionId(
    clientSubmissionId: string,
  ): Promise<DeliveryEventRecord | null> {
    return this.prisma.deliveryEvent.findUnique({
      where: { client_submission_id: clientSubmissionId },
      select: {
        id: true,
        type: true,
        deliveryId: true,
        client_submission_id: true,
      },
    });
  }

  async createDeliveryEvent(
    eventData: CreateDeliveryEventProps,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await (tx ?? this.prisma).deliveryEvent.create({
      data: {
        type: eventData.type,
        deliveryId: eventData.deliveryId,
        reportedById: eventData.reportedById,
        latitude: eventData.latitude ?? null,
        longitude: eventData.longitude ?? null,
        photo: eventData.photo ?? null,
        signature: eventData.signature ?? null,
        received_by: eventData.received_by ?? null,
        client_submission_id: eventData.client_submission_id,
      },
    });
  }

  async registerDeliveryProof(
    eventData: CreateDeliveryEventProps,
    expectedStatus: DeliveryStatus,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    // Event and status stamp land together or not at all: a proof without
    // the DELIVERED transition (or vice versa) would lie in the trail.
    //
    // The status filter makes that hold against a concurrent write too. If a
    // dispatcher cancelled the delivery while the driver was uploading the
    // photo, the update matches nothing, the transaction rolls back, and the
    // event never exists — rather than a PROOF row hanging off a cancelled
    // delivery, which no screen in the product knows how to show.
    // Interactive transaction rather than the array form, because the guard
    // has to read `count` and abort — the same shape as `assignDeliveries`.
    // Throwing in here rolls the event back with it.
    //
    // A caller that handed over its own transaction owns the commit boundary
    // and is joined rather than nested: Prisma refuses a transaction opened on
    // a transaction client, and the whole reason it passed one was to have the
    // route stop resolve in this same commit.
    const write = async (client: Prisma.TransactionClient) => {
      const moved = await client.delivery.updateMany({
        where: { id: eventData.deliveryId, status: expectedStatus },
        data: {
          status: "DELIVERED",
          delivered_at: new Date(),
          received_by: eventData.received_by ?? null,
        },
      });

      if (moved.count === 0) {
        throw new DeliveryStatusConflictError();
      }

      await client.deliveryEvent.create({
        data: {
          type: "PROOF",
          deliveryId: eventData.deliveryId,
          reportedById: eventData.reportedById,
          latitude: eventData.latitude ?? null,
          longitude: eventData.longitude ?? null,
          photo: eventData.photo ?? null,
          signature: eventData.signature ?? null,
          received_by: eventData.received_by ?? null,
          client_submission_id: eventData.client_submission_id,
        },
      });
    };

    if (tx) {
      await write(tx);
      return;
    }

    await this.prisma.$transaction(write);
  }
}

export { DeliveryRepository };
