import { Prisma, type PrismaClient } from "@prisma/client";

import {
  IDeliveryRepository,
  DeliveryStatusPatch,
  DeliveryAssignmentPatch,
  type OperationBacklog,
} from "./IDelivery-repository";

import {
  DeliveryAssignmentConflictError,
  DeliveryStatusConflictError,
} from "../usecases/errors/delivery-errors";

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

import database from "@/../infra/database";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";
import {
  groupedBy,
  relatedTo,
  rowsByKey,
} from "@/shared/database/related-rows";
import { deliveryExportRow, occurrenceExportRow } from "./export-rows";
import { narrowDeliverySearch, resolveDeliveryPeriod } from "./delivery-search";
import { narrowOccurrenceSearch } from "./occurrence-search";

import {
  OCCURRENCE_SORT,
  occurrenceFeedWhere,
  type OccurrenceFeedFilters,
} from "../usecases/list-occurrences/occurrence-feed";

import {
  DELIVERY_SORT,
  catalogFacetOptions,
  deliveryListWhere,
  isTenantOnlyDeliveryList,
  type DeliveryListFilters,
} from "../usecases/list-delivery/delivery-list";

// Every read surfaces the shipper name and the assignment context — the
// panels never fetch relations in a second round-trip.
const listInclude = {
  shipper: { select: { id: true, name: true } },
  driver: { select: { id: true, name: true, cnh: true } },
  vehicle: { select: { id: true, license_plate: true } },
} as const;

/**
 * listInclude, attached to rows read without it: each relation read for the
 * keys the rows carry, and not at all when none does. As an include, Prisma 7
 * queried the vehicle of a page without vehicles, the driver of a page of
 * unassigned deliveries and all three under an empty page
 * (shared/database/related-rows.ts). Same shape: a missing relation is null.
 */
async function withListRelations<
  Row extends {
    shipperId: string;
    driverId: string | null;
    vehicleId: string | null;
  },
>(client: Pick<PrismaClient, "shipper" | "driver" | "vehicle">, rows: Row[]) {
  const [shippers, drivers] = await Promise.all([
    rowsByKey(
      rows.map((row) => row.shipperId),
      (ids) =>
        client.shipper.findMany({
          where: { id: { in: ids } },
          select: listInclude.shipper.select,
        }),
    ),
    rowsByKey(
      rows.map((row) => row.driverId),
      (ids) =>
        client.driver.findMany({
          where: { id: { in: ids } },
          select: listInclude.driver.select,
        }),
    ),
  ]);

  const vehicles = await rowsByKey(
    rows.map((row) => row.vehicleId),
    (ids) =>
      client.vehicle.findMany({
        where: { id: { in: ids } },
        select: listInclude.vehicle.select,
      }),
  );

  return rows.map((row) => ({
    ...row,
    shipper: relatedTo(shippers, row.shipperId),
    driver: relatedTo(drivers, row.driverId),
    vehicle: relatedTo(vehicles, row.vehicleId),
  }));
}

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

/**
 * The tenant of a delivery, for the rows that copy it.
 *
 * Events and occurrences carry their delivery's business so the screens that
 * read them by tenant do not have to join every delivery the tenant ever had.
 * Read from the delivery itself, inside the writer's transaction, so the copy
 * cannot disagree with the original.
 */
async function tenantOfDelivery(
  client: Pick<Prisma.TransactionClient, "delivery">,
  deliveryId: string,
): Promise<string> {
  const { businessId } = await client.delivery.findUniqueOrThrow({
    where: { id: deliveryId },
    select: { businessId: true },
  });

  return businessId;
}

/**
 * The driver's view of their latest report that asked the tower. The type's
 * name is read apart, for the reports present (shared/database/related-rows.ts).
 */
const AUTHORIZATION_REQUEST_SELECT = {
  id: true,
  occurrenceTypeId: true,
  authorization_status: true,
  authorization_note: true,
  authorized_at: true,
  created_at: true,
} as const;

function toAuthorizationRequest(
  row: {
    id: string;
    occurrenceTypeId: string;
    authorization_status: OccurrenceAuthorizationStatus;
    authorization_note: string | null;
    authorized_at: Date | null;
    created_at: Date;
  },
  occurrenceType: { name: string },
) {
  return {
    occurrenceId: row.id,
    occurrenceTypeId: row.occurrenceTypeId,
    occurrenceTypeName: occurrenceType.name,
    status: row.authorization_status,
    note: row.authorization_note,
    decidedAt: row.authorized_at,
    requestedAt: row.created_at,
  };
}

/** Where an export batch ended: the last row's position in creation order. */
interface ExportKey {
  created_at: Date;
  id: string;
}

/**
 * The rows that come after `after` in (created_at, id) order.
 *
 * The second condition alone is the keyset. The first says the same thing in
 * a form the planner can use: `created_at >= x` becomes the lower bound of
 * the (businessId, created_at) index scan, so a batch starts where the last
 * one ended instead of re-reading the company from the beginning. The value
 * is a literal parameter, not a sub-select, so the planner sees it.
 */
function keysetAfter(after: ExportKey) {
  return [
    { created_at: { gte: after.created_at } },
    {
      OR: [
        { created_at: { gt: after.created_at } },
        { created_at: after.created_at, id: { gt: after.id } },
      ],
    },
  ];
}

class DeliveryRepository implements IDeliveryRepository {
  constructor(private prisma = database) {}

  async createDelivery(
    deliveryData: CreateDeliveryProps,
    tx?: Prisma.TransactionClient,
  ): Promise<Delivery> {
    const { items, ...delivery } = deliveryData;

    const deliveryCreated = await (tx ?? this.prisma).delivery.create({
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

  async findDeliveryBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<Delivery | null> {
    // The unique (businessId, client_submission_id) index answers this.
    const found = await this.prisma.delivery.findUnique({
      where: {
        businessId_client_submission_id: {
          businessId,
          client_submission_id: clientSubmissionId,
        },
      },
    });

    return found as Delivery | null;
  }

  async listDeliveries({
    page,
    pageSize,
    sort,
    order,
    ...requested
  }: ListDeliveriesProps): Promise<ListDeliveriesPage> {
    const skip = (page - 1) * pageSize;

    // An exact id / order / NF search ignores the period (a notification's
    // link finds last week's delivery); any other search stays inside it.
    const { filters: periodic, periodApplied } = await resolveDeliveryPeriod(
      this.prisma,
      requested,
    );

    // A selective search becomes the ids it matches (trigram index), so the
    // page and the three counts below read those rows instead of the
    // company's whole history each.
    const filters = await narrowDeliverySearch(this.prisma, periodic);

    // The page and the counts side by side (the two connections a screen may
    // hold). The counts replace a count(*): the pager total and the cards
    // both come out of them.
    const [rows, counted] = await Promise.all([
      this.prisma.delivery.findMany({
        skip,
        take: pageSize,
        where: deliveryListWhere(filters),
        orderBy: resolveOrderBy(DELIVERY_SORT, { sort, order }),
      }),
      this.countListFacets(filters),
    ]);

    const data = await withListRelations(this.prisma, rows);

    const { byStatus, byShipper, byDriver } = counted;

    const shipperIds = [
      ...new Set([
        ...byShipper.map((group) => group.shipperId),
        ...(filters.shipperIds ?? []),
      ]),
    ];

    const shippers = shipperIds.length
      ? await this.prisma.shipper.findMany({
          where: { businessId: filters.businessId, id: { in: shipperIds } },
          select: { id: true, name: true },
        })
      : [];

    const driverIds = [
      ...new Set([
        ...byDriver.flatMap((group) =>
          group.driverId ? [group.driverId] : [],
        ),
        ...(filters.driverIds ?? []),
      ]),
    ];

    const drivers = driverIds.length
      ? await this.prisma.driver.findMany({
          where: { businessId: filters.businessId, id: { in: driverIds } },
          select: { id: true, name: true },
        })
      : [];

    return {
      data: data as Delivery[],
      periodApplied,
      statusCounts: byStatus.map((group) => ({
        value: group.status,
        count: group._count._all,
      })),
      shipperOptions: catalogFacetOptions(
        byShipper.map((group) => ({
          value: group.shipperId,
          count: group._count._all,
        })),
        filters.shipperIds,
        new Map(shippers.map((shipper) => [shipper.id, shipper.name])),
      ),
      driverOptions: catalogFacetOptions(
        byDriver.map((group) => ({
          value: group.driverId,
          count: group._count._all,
        })),
        filters.driverIds,
        new Map(drivers.map((driver) => [driver.id, driver.name])),
      ),
    };
  }

  /**
   * The status, shipper and driver counts of the listing.
   *
   * Each facet is counted without its own filter (deliveryListWhere's
   * `except`), so with any facet chosen the three `where`s differ and stay
   * three grouped reads, one after the other. In the board's default view
   * (the `where` is only the tenant and the period, see
   * isTenantOnlyDeliveryList) the three are the SAME `where` — the
   * company's whole history without a period — and reading it three times
   * was the heaviest database work of the load test: 64 + 64 + 28 ms per page
   * on a tenant with 300k deliveries, a third of the database CPU at 120
   * req/s (docs/desempenho/carga-2026-10.md). There, one scan with GROUPING
   * SETS answers all three, inside the period when there is one (the cards
   * and the pager count what the table lists, never the whole history).
   */
  private async countListFacets(
    filters: Awaited<ReturnType<typeof narrowDeliverySearch>>,
  ): Promise<{
    byStatus: Array<{ status: DeliveryStatus; _count: { _all: number } }>;
    byShipper: Array<{ shipperId: string; _count: { _all: number } }>;
    byDriver: Array<{ driverId: string | null; _count: { _all: number } }>;
  }> {
    if (isTenantOnlyDeliveryList(filters)) {
      const scope = filters.scopeDriverId
        ? Prisma.sql`AND "driverId" = ${filters.scopeDriverId}`
        : Prisma.empty;

      // The period, as deliveryListWhere writes it: [createdFrom, createdTo).
      const period = Prisma.sql`${
        filters.createdFrom
          ? Prisma.sql`AND "created_at" >= ${filters.createdFrom}`
          : Prisma.empty
      } ${
        filters.createdTo
          ? Prisma.sql`AND "created_at" < ${filters.createdTo}`
          : Prisma.empty
      }`;

      const rows = await this.prisma.$queryRaw<
        Array<{
          status: DeliveryStatus | null;
          shipperId: string | null;
          driverId: string | null;
          set: number;
          count: number;
        }>
      >`
        SELECT
          "status"::text AS "status", "shipperId", "driverId",
          GROUPING("status", "shipperId", "driverId")::int AS "set",
          count(*)::int AS "count"
        FROM "public"."delivery"
        WHERE "businessId" = ${filters.businessId} ${scope} ${period}
        GROUP BY GROUPING SETS (("status"), ("shipperId"), ("driverId"))
      `;

      // GROUPING(...) is a bitmask of the columns rolled up, so a NULL
      // driverId of the driver set (unassigned deliveries) is told apart from
      // the NULL the other sets carry. 3 = status set, 5 = shipper, 6 = driver.
      return {
        byStatus: rows
          .filter((row) => row.set === 3 && row.status)
          .map((row) => ({
            status: row.status as DeliveryStatus,
            _count: { _all: row.count },
          })),
        byShipper: rows
          .filter((row) => row.set === 5 && row.shipperId)
          .map((row) => ({
            shipperId: row.shipperId as string,
            _count: { _all: row.count },
          })),
        byDriver: rows
          .filter((row) => row.set === 6)
          .map((row) => ({
            driverId: row.driverId,
            _count: { _all: row.count },
          })),
      };
    }

    const byStatus = await this.prisma.delivery.groupBy({
      by: ["status"],
      where: deliveryListWhere(filters, { except: "status" }),
      _count: { _all: true },
    });

    const byShipper = await this.prisma.delivery.groupBy({
      by: ["shipperId"],
      where: deliveryListWhere(filters, { except: "shipperId" }),
      _count: { _all: true },
    });

    const byDriver = await this.prisma.delivery.groupBy({
      by: ["driverId"],
      where: deliveryListWhere(filters, { except: "driverId" }),
      _count: { _all: true },
    });

    return { byStatus, byShipper, byDriver };
  }

  async findDeliveryById(deliveryId: string): Promise<Delivery | null> {
    const found = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
    });

    return found as Delivery | null;
  }

  /**
   * The delivery with everything its screen shows.
   *
   * The lists come with the row; what they point at (people, reasons,
   * occurrence types, the import, the list relations) is read afterwards for
   * the keys present, and not at all when there are none. As one include,
   * Prisma 7 ran each of those under a null key or an empty list — fifteen
   * statements for a delivery with no occurrence, message or import, where
   * Prisma 6 spent seven (shared/database/related-rows.ts). The people of the
   * trail, the occurrences and the messages are one lookup. Same shape and
   * key order as the include.
   */
  async findDeliveryDetailById(deliveryId: string): Promise<unknown | null> {
    const found = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        items: true,
        // The trail, newest first: arrivals and proofs from the app, status
        // overrides and notes from the panel. The reason comes along because
        // it is the sentence support is scanning for.
        events: { orderBy: { created_at: "desc" } },
        occurrences: { orderBy: { created_at: "desc" } },

        /**
         * The messages that named this delivery as their context.
         *
         * Capped, and deliberately: a chat thread is a conversation with a
         * driver over months, and a support screen about ONE delivery wants
         * the exchange about that delivery, not the thread. Anyone who needs
         * the whole conversation opens the chat, which is where it lives.
         */
        chatMessages: {
          orderBy: { created_at: "desc" },
          take: 50,
          select: {
            id: true,
            kind: true,
            body: true,
            created_at: true,
            senderId: true,
          },
        },
      },
    });

    if (!found) return null;

    const { items, events, occurrences, chatMessages, ...row } = found;

    const [delivery] = await withListRelations(this.prisma, [row]);

    const [imported, people] = await Promise.all([
      // Where it came from: the edit form locks the items of an NF-e XML
      // delivery (they are what the note declared) and not a typed one's.
      row.importId
        ? this.prisma.import.findUnique({
            where: { id: row.importId },
            select: { source: true },
          })
        : null,
      rowsByKey(
        [
          ...events.map((event) => event.reportedById),
          ...occurrences.flatMap((occurrence) => [
            occurrence.reportedById,
            occurrence.authorizedById,
          ]),
          ...chatMessages.map((message) => message.senderId),
        ],
        (ids) =>
          this.prisma.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          }),
      ),
    ]);

    const [reasons, occurrenceTypes] = await Promise.all([
      rowsByKey(
        events.map((event) => event.reasonId),
        (ids) =>
          this.prisma.statusChangeReason.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          }),
      ),
      rowsByKey(
        occurrences.map((occurrence) => occurrence.occurrenceTypeId),
        (ids) =>
          this.prisma.occurrenceType.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              name: true,
              blocks_delivery: true,
              // The form the answers are labelled with, and whether the
              // type asks the tower (decisions 6.2 and 6.3).
              requires_authorization: true,
              form_fields: true,
              form_version: true,
            },
          }),
      ),
    ]);

    return {
      ...delivery,
      items,
      import: imported,
      events: events.map((event) => ({
        ...event,
        reportedBy: relatedTo(people, event.reportedById),
        reason: relatedTo(reasons, event.reasonId),
      })),
      occurrences: occurrences.map((occurrence) => ({
        ...occurrence,
        occurrenceType: relatedTo(occurrenceTypes, occurrence.occurrenceTypeId),
        reportedBy: relatedTo(people, occurrence.reportedById),
        authorizedBy: relatedTo(people, occurrence.authorizedById),
      })),
      chatMessages: chatMessages.map(({ senderId, ...message }) => ({
        ...message,
        sender: relatedTo(people, senderId),
      })),
    };
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

  /**
   * The panel's edit, guarded by the status it read.
   *
   * The use case reads the status and runs three more lookups before writing;
   * the driver can prove the delivery in that window, and an unguarded edit
   * would rewrite a delivery whose receipt is signed and whose webhook left.
   * `updateMany` with the expected status in `where`, `count === 0` → 409,
   * like `updateDeliveryStatus` and every route transition: no index can
   * express this precondition.
   */
  async updateDelivery(
    deliveryId: string,
    deliveryData: UpdateDeliveryProps,
    expectedStatus?: DeliveryStatus,
  ): Promise<Delivery> {
    const { items, ...fields } = deliveryData;

    const filteredData = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );

    // One commit for the row and its item list: an edit that saved the
    // address but lost the items (or the reverse) is an edit nobody asked for.
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.delivery.updateMany({
        where: {
          id: deliveryId,
          ...(expectedStatus && { status: expectedStatus }),
        },
        data: filteredData,
      });

      if (count === 0) {
        throw new DeliveryStatusConflictError();
      }

      // The list is replaced as a whole — the form sends the list it shows.
      if (items !== undefined) {
        await tx.deliveryItem.deleteMany({ where: { deliveryId } });

        if (items.length > 0) {
          await tx.deliveryItem.createMany({
            data: items.map((item) => ({
              deliveryId,
              description: item.description,
              quantity: item.quantity ?? 1,
              unit: item.unit || null,
              unit_value: item.unit_value ?? null,
            })),
          });
        }
      }

      const updated = await tx.delivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });

      return updated as Delivery;
    });
  }

  async findOpenStopRoute(
    deliveryId: string,
  ): Promise<{ routeId: string; status: string } | null> {
    const stop = await this.prisma.routeStop.findFirst({
      where: { deliveryId, status: { in: ["PENDING", "ARRIVED"] } },
      select: { route: { select: { id: true, status: true } } },
    });

    return stop ? { routeId: stop.route.id, status: stop.route.status } : null;
  }

  async findDeliveryImportSource(
    deliveryId: string,
  ): Promise<"SPREADSHEET" | "NFE_XML" | null> {
    const found = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { import: { select: { source: true } } },
    });

    return found?.import?.source ?? null;
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
    outerTx?: Prisma.TransactionClient,
  ): Promise<void> {
    const write = async (tx: Prisma.TransactionClient) => {
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
    };

    // Joins the caller's transaction when there is one. Opening our own
    // inside it would not nest in Prisma — it takes a second connection and
    // waits on rows the caller is already holding, which is a deadlock that
    // only shows up under load.
    if (outerTx) return write(outerTx);

    await this.prisma.$transaction(write);
  }

  async createOccurrence(
    occurrenceData: CreateOccurrenceProps,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string }> {
    const client = tx ?? this.prisma;

    return client.deliveryOccurrence.create({
      data: {
        deliveryId: occurrenceData.deliveryId,
        businessId: await tenantOfDelivery(client, occurrenceData.deliveryId),
        occurrenceTypeId: occurrenceData.occurrenceTypeId,
        reportedById: occurrenceData.reportedById,
        description: occurrenceData.description || null,
        latitude: occurrenceData.latitude ?? null,
        longitude: occurrenceData.longitude ?? null,
        photos: occurrenceData.photos ?? [],
        client_submission_id: occurrenceData.client_submission_id ?? null,
        occurred_at: occurrenceData.occurred_at ?? null,
        // No answers is SQL NULL (DbNull), not the JSON literal null.
        form_answers: occurrenceData.form_answers
          ? (occurrenceData.form_answers as Prisma.InputJsonValue)
          : Prisma.DbNull,
        form_version: occurrenceData.form_version ?? null,
        // Undefined leaves the column default (NOT_REQUIRED).
        authorization_status: occurrenceData.authorization_status,
        authorizedById: occurrenceData.authorizedById ?? null,
        authorized_at: occurrenceData.authorized_at ?? null,
        // Decision 14.3. Undefined leaves the column default (NOT_DELIVERED).
        category: occurrenceData.category,
        receipt_photo: occurrenceData.receipt_photo ?? null,
        signature: occurrenceData.signature ?? null,
        received_by: occurrenceData.received_by ?? null,
      },
      select: { id: true },
    });
  }

  async findOccurrenceBySubmissionId(
    clientSubmissionId: string,
    businessId: string,
  ): Promise<{
    id: string;
    authorization_status: OccurrenceAuthorizationStatus;
    category: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";
  } | null> {
    // `findFirst`, not `findUnique`: the key is globally unique, but the
    // question is "this submission IN THIS company?" — another company's
    // key must read as absent.
    return this.prisma.deliveryOccurrence.findFirst({
      where: {
        client_submission_id: clientSubmissionId,
        delivery: { businessId },
      },
      select: { id: true, authorization_status: true, category: true },
    });
  }

  async listOccurrences({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListOccurrencesProps): Promise<ListOccurrencesResult> {
    const skip = (page - 1) * pageSize;

    // The search's joined arms resolved to ids first, through their indexes
    // (occurrence-search.ts). Before the page, not beside it: it is what the
    // page and the counts filter on.
    const narrowed = await narrowOccurrenceSearch(this.prisma, filters);

    // The page and the per-type counts side by side (the two connections a
    // screen may hold); the type names after, on one of them. The counts
    // replace a count(*): the pager total is derived from them.
    const [data, grouped] = await Promise.all([
      this.prisma.deliveryOccurrence.findMany({
        skip,
        take: pageSize,
        where: occurrenceFeedWhere(narrowed, { withTypeFacets: true }),
        orderBy: resolveOrderBy(OCCURRENCE_SORT, { sort, order }),
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
      this.prisma.deliveryOccurrence.groupBy({
        by: ["occurrenceTypeId"],
        where: occurrenceFeedWhere(narrowed, { withTypeFacets: false }),
        _count: { _all: true },
      }),
    ]);

    const counts = new Map(
      grouped.map((group) => [group.occurrenceTypeId, group._count._all]),
    );

    const typeIds = new Set([
      ...counts.keys(),
      ...(filters.occurrenceTypeIds ?? []),
    ]);

    // Scoped to the company: a selected id of another tenant resolves to
    // nothing, so its name never comes back.
    const types =
      typeIds.size > 0
        ? await this.prisma.occurrenceType.findMany({
            where: { businessId: filters.businessId, id: { in: [...typeIds] } },
            select: {
              id: true,
              name: true,
              blocks_delivery: true,
              category: true,
            },
          })
        : [];

    return {
      data,
      typeCounts: types.map((type) => ({
        ...type,
        count: counts.get(type.id) ?? 0,
      })),
    };
  }

  async operationBacklog(
    businessId: string,
    day: OperationDay,
  ): Promise<OperationBacklog> {
    // The columns are UTC timestamps without a zone (how Prisma stores a
    // DateTime), so each bound is converted explicitly instead of leaving the
    // comparison to the session's TimeZone — and sent as an ISO string, since
    // Prisma 7's pg driver sends a Date without its offset.
    const start = Prisma.sql`(${day.start.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
    const end = Prisma.sql`(${day.end.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

    /**
     * "Sem rota": PENDING without a driver, of any date — the dispatcher's
     * backlog, a snapshot of right now and deliberately not the tower's day
     * (a delivery nobody routed yesterday is still owed today). The status
     * is a literal so the (businessId, status, …) index serves the generic
     * plan too.
     */
    const [{ unassigned }] = await this.prisma.$queryRaw<
      Array<{ unassigned: number }>
    >`
      SELECT count(*)::int AS "unassigned"
      FROM "delivery" d
      WHERE d."businessId" = ${businessId}
        AND d."status" = 'PENDING'
        AND d."driverId" IS NULL
    `;

    /**
     * "Relatadas pelo motorista": reports made by a driver's account, placed
     * in the day by when they happened on the phone (an offline report of
     * yesterday arrives today). Panel notes and the platform's own
     * "Comprovante rejeitado" (is_system) are not driver reports
     * (DLVP-OPS-2). `created_at >= start` keeps the read on
     * (businessId, created_at): a report never happened after it arrived.
     *
     * After the backlog, not beside it: one connection at a time.
     */
    const [{ occurrences }] = await this.prisma.$queryRaw<
      Array<{ occurrences: number }>
    >`
      SELECT count(*)::int AS "occurrences"
      FROM "delivery_occurrence" o
      JOIN "occurrence_type" t ON t."id" = o."occurrenceTypeId"
      JOIN "user" u ON u."id" = o."reportedById"
      WHERE o."businessId" = ${businessId}
        AND o."created_at" >= ${start}
        AND LEAST(COALESCE(o."occurred_at", o."created_at"), o."created_at") >= ${start}
        AND LEAST(COALESCE(o."occurred_at", o."created_at"), o."created_at") < ${end}
        AND t."is_system" = false
        -- Decision 14.3: a proven delivery is a DELIVERED occurrence now,
        -- and "Ocorrências hoje" counts problems, not deliveries.
        AND o."category" = 'NOT_DELIVERED'
        AND u."driverId" IS NOT NULL
    `;

    return {
      unassigned: Number(unassigned),
      occurrencesToday: Number(occurrences),
    };
  }

  async listDriverDeliveries(
    businessId: string,
    driverId: string,
  ): Promise<unknown[]> {
    const rows = await this.prisma.delivery.findMany({
      where: {
        businessId,
        driverId,
        // Decision 14.7, D8 (design §4.13): what is on the street, plus what
        // waits on a route the dispatcher RELEASED. A PLANNED route is a
        // draft the driver must not see change while it is being dragged, and
        // a PENDING delivery with a driver and no route is the old direct
        // assignment, which no longer reaches the phone.
        OR: [
          { status: "IN_TRANSIT" },
          {
            status: "PENDING",
            stops: {
              some: {
                status: { in: ["PENDING", "ARRIVED"] },
                route: { status: { in: ["RELEASED", "IN_PROGRESS"] } },
              },
            },
          },
        ],
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

    /**
     * What the list carries, read for the deliveries present, as the include
     * did, and nothing for a driver with nothing to do: as an include,
     * Prisma 7 ran the shipper, items, stops, routes, requests and types
     * under an empty list — the first screen of every idle driver — and the
     * routes and types under a list with no stop and no request
     * (shared/database/related-rows.ts). Same shape, key and item order.
     */
    if (rows.length === 0) return [];

    const deliveryIds = rows.map((row) => row.id);

    const [shippers, items] = await Promise.all([
      rowsByKey(
        rows.map((row) => row.shipperId),
        (ids) =>
          this.prisma.shipper.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          }),
      ),
      this.prisma.deliveryItem.findMany({
        where: { deliveryId: { in: deliveryIds } },
      }),
    ]);

    const [stops, requests] = await Promise.all([
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
      this.prisma.routeStop.findMany({
        where: {
          deliveryId: { in: deliveryIds },
          status: { in: ["PENDING", "ARRIVED"] },
        },
        select: {
          id: true,
          sequence: true,
          status: true,
          // "Chegada registrada às HH:MM" for an arrival made on another
          // phone or before this cache was filled (MOB-11).
          arrived_at: true,
          // "A caminho desde HH:MM" (decision 6.4), restored after a
          // reinstall or on another phone; the app keeps its own marks too.
          on_the_way_at: true,
          deliveryId: true,
          routeId: true,
        },
      }),

      // The latest report that asked the tower (decision 6.3): the card
      // shows "Aguardando autorização" or the answer, from the same cached
      // payload the app reads offline. Only THIS driver's own request: a
      // panel report (self-authorized, or filed by an office profile) is
      // not something the driver asked, nor is the request of the driver
      // who held the delivery before it was handed over. Newest first with
      // the id as tiebreak, so the first per delivery is the include's
      // `take: 1`.
      this.prisma.deliveryOccurrence.findMany({
        where: {
          deliveryId: { in: deliveryIds },
          authorization_status: { not: "NOT_REQUIRED" },
          reportedBy: { driverId },
        },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        select: { ...AUTHORIZATION_REQUEST_SELECT, deliveryId: true },
      }),
    ]);

    const [routes, occurrenceTypes] = await Promise.all([
      rowsByKey(
        stops.map((stop) => stop.routeId),
        (ids) =>
          this.prisma.route.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              code: true,
              name: true,
              status: true,
              // The plan the app prints under each route (DLVP-ROUTE-1).
              destination: true,
              planned_departure_at: true,
              planned_arrival_at: true,
              // Decision 14.4: the app offers a pause on a RELEASED route
              // only on its day (date-only, UTC midnight).
              scheduled_date: true,
              // Decision 14.7 (design §6): the app keeps it in its cache and
              // tells the driver once when the plan changed while offline.
              plan_version: true,
            },
          }),
      ),
      rowsByKey(
        requests.map((request) => request.occurrenceTypeId),
        (ids) =>
          this.prisma.occurrenceType.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          }),
      ),
    ]);

    const itemsOf = groupedBy(items, (item) => item.deliveryId);
    const stopsOf = groupedBy(stops, (stop) => stop.deliveryId);
    const requestsOf = groupedBy(requests, (request) => request.deliveryId);

    return rows.map((row) => {
      const request = requestsOf.get(row.id)?.[0];

      return {
        ...row,
        // A required relation: the delivery's foreign key keeps its shipper.
        shipper: shippers.get(row.shipperId)!,
        items: itemsOf.get(row.id) ?? [],
        stops: (stopsOf.get(row.id) ?? []).map(
          ({ deliveryId: _deliveryId, routeId, ...stop }) => ({
            ...stop,
            route: relatedTo(routes, routeId),
          }),
        ),
        authorization_request: request
          ? toAuthorizationRequest(
              request,
              // A required relation, like the shipper.
              occurrenceTypes.get(request.occurrenceTypeId)!,
            )
          : null,
      };
    });
  }

  async countPendingForDriver(
    businessId: string,
    driverId: string,
    createdUpTo?: Date,
  ): Promise<number> {
    return this.prisma.delivery.count({
      where: {
        businessId,
        driverId,
        status: "PENDING",
        ...NOT_ON_A_ROUTE,
        ...(createdUpTo && { created_at: { lte: createdUpTo } }),
      },
    });
  }

  async startDriverRoute(
    businessId: string,
    driverId: string,
    createdUpTo?: Date,
  ): Promise<number> {
    // Naturally idempotent: a resend finds nothing left to move. A tap sent
    // late moves only what existed when it was made (MOB-08): the batch is
    // picked now, and a delivery created since was never on the phone.
    const result = await this.prisma.delivery.updateMany({
      where: {
        businessId,
        driverId,
        status: "PENDING",
        ...NOT_ON_A_ROUTE,
        ...(createdUpTo && { created_at: { lte: createdUpTo } }),
      },
      data: { status: "IN_TRANSIT" },
    });

    return result.count;
  }

  async findEventBySubmissionId(
    clientSubmissionId: string,
    businessId: string,
  ): Promise<DeliveryEventRecord | null> {
    return this.prisma.deliveryEvent.findFirst({
      where: {
        client_submission_id: clientSubmissionId,
        delivery: { businessId },
      },
      select: {
        id: true,
        type: true,
        deliveryId: true,
        client_submission_id: true,
      },
    });
  }

  async findDeliveryByShipperAndCode(
    businessId: string,
    shipperId: string,
    code: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Delivery | null> {
    const found = await (tx ?? this.prisma).delivery.findFirst({
      where: { businessId, shipperId, code },
    });

    return found as Delivery | null;
  }

  async lockOrderIdentity(
    businessId: string,
    shipperId: string,
    code: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    // $executeRaw rather than $queryRaw: the function returns void, a column
    // type Prisma cannot deserialize. Released by the commit or rollback.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`delivery-order:${businessId}:${shipperId}:${code}`}, 0))`;
  }

  /**
   * Batched by keyset, a thousand at a time, in creation order.
   *
   * The key is (created_at, id), never created_at alone: two rows written in
   * the same millisecond would otherwise straddle a batch boundary and one of
   * them be repeated or skipped, and an export that quietly loses a row is
   * worse than one that fails. The id breaks the tie, so the key is unique.
   *
   * It used to be Prisma's `cursor` over `id`. Prisma sends that cursor as a
   * sub-select, so the planner never sees the value, and no index leads with
   * (businessId, id): every batch either sorted the whole company or walked
   * the primary key through every other company's rows (see keysetAfter).
   */
  async *streamDeliveriesForExport(
    filters: DeliveryListFilters,
  ): AsyncGenerator<Record<string, unknown>> {
    // The listing's own `where` (decision 5.8): the file is what the screen
    // shows — the period (and its exact-search exception), the id and the
    // driver searches, and every facet, included.
    const { filters: periodic } = await resolveDeliveryPeriod(
      this.prisma,
      filters,
    );
    const where = deliveryListWhere(
      await narrowDeliverySearch(this.prisma, periodic),
    );

    const batchSize = 1000;

    let after: ExportKey | null = null;

    while (true) {
      const batch = await this.prisma.delivery.findMany({
        where: after ? { AND: [where, ...keysetAfter(after)] } : where,
        include: {
          shipper: { select: { name: true } },
          driver: { select: { name: true } },
          vehicle: { select: { license_plate: true } },
          stops: {
            select: { route: { select: { code: true } } },
            orderBy: { created_at: "desc" },
            take: 1,
          },
        },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
        take: batchSize,
      });

      if (batch.length === 0) break;

      for (const delivery of batch) {
        yield deliveryExportRow(delivery, {
          shipperName: delivery.shipper?.name ?? null,
          driverName: delivery.driver?.name ?? null,
          vehiclePlate: delivery.vehicle?.license_plate ?? null,
          routeCode: delivery.stops[0]?.route?.code ?? null,
        });
      }

      // Typed, or the loop's own inference would chase itself through
      // `after` back into this batch's query.
      const last: ExportKey = batch[batch.length - 1];
      after = { created_at: last.created_at, id: last.id };

      if (batch.length < batchSize) break;
    }
  }

  async *streamOccurrencesForExport(
    filters: OccurrenceFeedFilters,
  ): AsyncGenerator<Record<string, unknown>> {
    // The feed's own `where` (decision 5.8): both copiable ids are searched
    // and every facet applies, so the file is what the screen shows. On the
    // occurrence's own copy of the tenant, which its (businessId, created_at)
    // index serves.
    // Resolved once for the whole file: the matched ids do not move between
    // batches any more than the term does.
    const where = occurrenceFeedWhere(
      await narrowOccurrenceSearch(this.prisma, filters),
      { withTypeFacets: true },
    );

    const batchSize = 1000;

    // Same keyset as the deliveries' export, for the same reasons.
    let after: ExportKey | null = null;

    while (true) {
      const batch = await this.prisma.deliveryOccurrence.findMany({
        where: after ? { AND: [where, ...keysetAfter(after)] } : where,
        include: {
          occurrenceType: {
            select: { name: true, blocks_delivery: true, form_fields: true },
          },
          reportedBy: { select: { name: true } },
          authorizedBy: { select: { name: true } },
          delivery: {
            select: { id: true, recipient_name: true, city: true, uf: true },
          },
        },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
        take: batchSize,
      });

      if (batch.length === 0) break;

      for (const occurrence of batch) {
        yield occurrenceExportRow(occurrence, {
          typeName: occurrence.occurrenceType?.name ?? null,
          blocksDelivery: occurrence.occurrenceType?.blocks_delivery === true,
          formFields: occurrence.occurrenceType?.form_fields ?? null,
          delivery: occurrence.delivery ?? null,
          reporterName: occurrence.reportedBy?.name ?? null,
          deciderName: occurrence.authorizedBy?.name ?? null,
        });
      }

      const last: ExportKey = batch[batch.length - 1];
      after = { created_at: last.created_at, id: last.id };

      if (batch.length < batchSize) break;
    }
  }

  async countDeliveriesReferencing(reference: {
    driverId?: string;
    vehicleId?: string;
  }): Promise<number> {
    return this.prisma.delivery.count({
      where: {
        ...(reference.driverId && { driverId: reference.driverId }),
        ...(reference.vehicleId && { vehicleId: reference.vehicleId }),
      },
    });
  }

  async createDeliveryEvent(
    eventData: CreateDeliveryEventProps,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;

    await client.deliveryEvent.create({
      data: {
        type: eventData.type,
        deliveryId: eventData.deliveryId,
        businessId: await tenantOfDelivery(client, eventData.deliveryId),
        reportedById: eventData.reportedById ?? null,

        // Defaults to USER because that is what every source was until the
        // timeline existed; the column's own default says the same, and both
        // saying it is what keeps an older caller honest.
        actor: eventData.actor ?? "USER",
        device: eventData.device ?? null,

        latitude: eventData.latitude ?? null,
        longitude: eventData.longitude ?? null,
        photo: eventData.photo ?? null,
        signature: eventData.signature ?? null,
        received_by: eventData.received_by ?? null,

        note: eventData.note ?? null,
        status_from: eventData.status_from ?? null,
        status_to: eventData.status_to ?? null,
        reasonId: eventData.reasonId ?? null,

        client_submission_id: eventData.client_submission_id ?? null,
        occurred_at: eventData.occurred_at ?? null,

        occurrenceId: eventData.occurrenceId ?? null,
        routeId: eventData.routeId ?? null,
      },
    });
  }

  async registerDeliveryProof(
    eventData: CreateDeliveryEventProps,
    expectedStatus: DeliveryStatus,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
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
          // The moment of the proof when the app sent it later, not the
          // moment the upload finally went through (MOB-08).
          delivered_at: eventData.occurred_at ?? new Date(),
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
          businessId: await tenantOfDelivery(client, eventData.deliveryId),
          reportedById: eventData.reportedById,
          latitude: eventData.latitude ?? null,
          longitude: eventData.longitude ?? null,
          photo: eventData.photo ?? null,
          signature: eventData.signature ?? null,
          received_by: eventData.received_by ?? null,
          client_submission_id: eventData.client_submission_id ?? null,
          occurred_at: eventData.occurred_at ?? null,
          // Decision 14.3: the DELIVERED occurrence this proof applies.
          occurrenceId: eventData.occurrenceId ?? null,
          // Decision 14.8 (design §7.2): who sent it, from which phone, on
          // which route, and when the photo was taken.
          actor: eventData.actor ?? "USER",
          device: eventData.device ?? null,
          device_id: eventData.device_id ?? null,
          photo_taken_at: eventData.photo_taken_at ?? null,
          routeId: eventData.routeId ?? null,
        },
      });

      // Decision 6.3: the proof wins over a request still waiting for the
      // tower. After the delivery row, the order every writer of a delivery
      // and its occurrences takes, so an approval racing this proof waits
      // instead of deadlocking.
      //
      // Read, then written by id: the delivery row this transaction just
      // updated holds every other writer of its requests, so the two agree.
      // The ids go back to the caller for the tickets' trail (design §5.2).
      const waiting = await client.deliveryOccurrence.findMany({
        where: {
          deliveryId: eventData.deliveryId,
          authorization_status: "PENDING",
        },
        select: { id: true },
      });

      if (waiting.length === 0) return [];

      const ids = waiting.map((row) => row.id);

      await client.deliveryOccurrence.updateMany({
        where: { id: { in: ids }, authorization_status: "PENDING" },
        data: { authorization_status: "SUPERSEDED" },
      });

      return ids;
    };

    if (tx) return write(tx);

    return this.prisma.$transaction(write);
  }
}

export { DeliveryRepository };
