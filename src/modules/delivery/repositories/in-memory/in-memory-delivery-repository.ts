import { v7 as uuidV7 } from "uuid";
import {
  IDeliveryRepository,
  DeliveryStatusPatch,
  DeliveryAssignmentPatch,
  type OperationBacklog,
} from "../IDelivery-repository";

import {
  DeliveryAssignmentConflictError,
  DeliveryStatusConflictError,
} from "../../usecases/errors/delivery-errors";

import { DeliveryStatus } from "@/shared/delivery/delivery-rules";
import {
  DELIVERY_COLUMN_DEFAULTS,
  DELIVERY_EVENT_COLUMN_DEFAULTS,
  DELIVERY_OCCURRENCE_COLUMN_DEFAULTS,
  withColumnDefaults,
} from "@/shared/in-memory/column-defaults";
import { asDateColumn } from "@/shared/in-memory/date-column";
import { factInstant } from "@/shared/route/operation-day-rules";
import type { OperationDay } from "@/modules/route/repositories/IOperation-day-repository";

import {
  OCCURRENCE_SORT_FALLBACK,
  selectedCategory,
  severityAsBlocking,
  type OccurrenceFeedFilters,
  type OccurrenceSortKey,
} from "../../usecases/list-occurrences/occurrence-feed";

import {
  DELIVERY_LIST_STATUSES,
  DELIVERY_SORT_FALLBACK,
  catalogFacetOptions,
  type DeliveryFacet,
  type DeliveryListFilters,
  type DeliverySortKey,
} from "../../usecases/list-delivery/delivery-list";

import {
  recordNotFound,
  uniqueViolation,
} from "@/shared/in-memory/prisma-errors";
import {
  byCreationThenId,
  deliveryExportRow,
  occurrenceExportRow,
} from "../export-rows";

import {
  compareForOrder,
  type OrderValue,
} from "@/shared/pagination/in-memory-order";

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
  ListOccurrencesProps,
  ListOccurrencesResult,
  OccurrenceAuthorizationStatus,
} from "../../dtos/delivery-dto";

/** delivery_item as the Prisma writes store it: quantity 1, empty unit NULL. */
function asStoredItems(items: DeliveryItemInput[]): DeliveryItemInput[] {
  return items.map((item) => ({
    description: item.description,
    quantity: item.quantity ?? 1,
    unit: item.unit || null,
    unit_value: item.unit_value ?? null,
  }));
}

class InMemoryDeliveryRepository implements IDeliveryRepository {
  public deliveries: Delivery[] = [];
  public occurrences: Array<
    CreateOccurrenceProps & {
      id: string;
      created_at: Date;
      updated_at?: Date;
      // The delivery's tenant, copied at insert (optional: tests push rows).
      businessId?: string;
      // The tower's decision columns (decision 6.3), written by the
      // authorization twin; null when never set, as in the table.
      authorization_note?: string | null;
      escalated_at?: Date | null;
    }
  > = [];
  // created_at is the column's now() default, as in the table.
  public events: Array<
    CreateDeliveryEventProps & {
      id: string;
      created_at: Date;
      businessId?: string;
    }
  > = [];

  /**
   * Test seams: the in-memory store has no occurrence-type or driver
   * tables, so panel tests seed these maps directly.
   */
  public occurrenceTypeBlocking = new Map<string, boolean>();
  public occurrenceTypeNames = new Map<string, string>();
  public reporterNames = new Map<string, string>();

  /**
   * occurrence_type.businessId: whose catalog a type is. The feed counts and
   * names only the company's types, as the Prisma lookup does; a type with
   * no business here is not the company's.
   */
  public occurrenceTypeBusiness = new Map<string, string>();

  /** occurrence_type.requires_photo. */
  public occurrenceTypeRequiresPhoto = new Map<string, boolean>();

  /** occurrence_type.category (decision 14.3); absent reads as NOT_DELIVERED. */
  public occurrenceTypeCategory = new Map<
    string,
    "DELIVERED" | "NOT_DELIVERED" | "PAUSE"
  >();
  public driverDirectory = new Map<string, { name: string; cnh: string }>();

  /** shipper.name by id: the listing's embedded shipper and its facet. */
  public shipperNames = new Map<string, string>();

  /** vehicle.license_plate by id: the export's plate column. */
  public vehiclePlates = new Map<string, string>();

  /** route.code by route id: the export's route column (latest stop). */
  public routeCodes = new Map<string, number>();

  /** occurrence_type.form_fields by type id: the occurrence export labels. */
  public occurrenceTypeFormFields = new Map<string, unknown>();

  /** occurrence_type.requires_authorization and form_version (decision 6.2/6.3). */
  public occurrenceTypeRequiresAuthorization = new Map<string, boolean>();
  public occurrenceTypeFormVersion = new Map<string, number>();

  /** status_change_reason.name by id: the trail's reason. */
  public reasonNames = new Map<string, string>();

  /** chat_message rows that name a delivery as their context. */
  public chatMessages: Array<{
    deliveryId: string;
    id: string;
    kind: string;
    body: string | null;
    created_at: Date;
    sender: { id: string; name: string } | null;
  }> = [];

  /** occurrence_type.is_system (the platform's "Comprovante rejeitado"). */
  public occurrenceTypeSystem = new Map<string, boolean>();

  /** Users whose account is a driver's (user.driverId IS NOT NULL). */
  public driverUserIds = new Set<string>();

  /** user.driverId by user id: WHICH driver an account belongs to. */
  public driverOfUser = new Map<string, string>();

  /** delivery_item rows, by delivery (the table the Prisma writes use). */
  public deliveryItems = new Map<string, DeliveryItemInput[]>();

  /** import.source by import id: the upload table this twin does not own. */
  public importSources = new Map<string, "SPREADSHEET" | "NFE_XML">();

  /**
   * The route stops, as the real `where` sees them.
   *
   * The batch departure must not touch a delivery that belongs to a route —
   * that one leaves with its route. In Postgres that is a relation filter; here
   * a test hands over the route fake's own array, so the two fakes see one set
   * of stops. Empty by default, which is the truth for every test that has no
   * routes at all.
   */
  public routeStops: Array<{
    deliveryId: string;
    status: string;
    routeId?: string;
    // The status of the stop's route, for findOpenStopRoute.
    routeStatus?: string;
    // route_stop.created_at: a new stop is a new attempt for the tower's
    // liveness rule. Absent reads as older than anything, like createdBy.
    created_at?: Date;
  }> = [];

  /** One occurrence_type row, written to every map the reads consult. */
  seedOccurrenceType(type: {
    id: string;
    businessId: string;
    name: string;
    blocks_delivery: boolean;
    requires_photo?: boolean;
    is_system?: boolean;
    category?: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";
  }): void {
    this.occurrenceTypeCategory.set(type.id, type.category ?? "NOT_DELIVERED");
    this.occurrenceTypeBusiness.set(type.id, type.businessId);
    this.occurrenceTypeNames.set(type.id, type.name);
    this.occurrenceTypeBlocking.set(type.id, type.blocks_delivery);
    this.occurrenceTypeRequiresPhoto.set(type.id, type.requires_photo === true);
    this.occurrenceTypeSystem.set(type.id, type.is_system === true);
  }

  private onAnOpenStop(deliveryId?: string): boolean {
    return this.routeStops.some(
      (stop) =>
        stop.deliveryId === deliveryId &&
        (stop.status === "PENDING" || stop.status === "ARRIVED"),
    );
  }

  async createDelivery(deliveryData: CreateDeliveryProps): Promise<Delivery> {
    const { items, ...given } = deliveryData;

    // As the Prisma create: an empty code, key or number is NULL, so two
    // deliveries without an NF-e key never collide on the unique index.
    const delivery = {
      ...given,
      code: given.code || null,
      invoice_key: given.invoice_key || null,
      invoice_number: given.invoice_number || null,
    };

    // The unique (businessId, invoice_key) index: a second row with the same
    // key fails like Postgres does, so a use case's race branch is testable.
    if (
      delivery.invoice_key &&
      this.deliveries.some(
        (existing) =>
          existing.businessId === delivery.businessId &&
          existing.invoice_key === delivery.invoice_key,
      )
    ) {
      throw uniqueViolation(["businessId", "invoice_key"]);
    }

    // The unique (businessId, client_submission_id) index: the same
    // Idempotency-Key is one delivery, and the panel's and the integration's
    // race branches read the second insert's failure.
    if (
      delivery.client_submission_id &&
      this.submissions.has(
        `${delivery.businessId}:${delivery.client_submission_id}`,
      )
    ) {
      throw uniqueViolation(["businessId", "client_submission_id"]);
    }

    const newDelivery: Delivery = {
      id: uuidV7(),
      // now() default of the column; the listing orders by it.
      created_at: new Date(),
      // @updatedAt is written on INSERT too.
      updated_at: new Date(),
      ...withColumnDefaults(DELIVERY_COLUMN_DEFAULTS, delivery),
      // A `date` column: the table keeps the UTC day (decision 1.3).
      ...(delivery.scheduled_date !== undefined && {
        scheduled_date: asDateColumn(delivery.scheduled_date),
      }),
      status: "PENDING",
    };

    this.deliveries.push(newDelivery);
    this.deliveryItems.set(newDelivery.id!, asStoredItems(items ?? []));

    if (deliveryData.client_submission_id) {
      this.submissions.set(
        `${deliveryData.businessId}:${deliveryData.client_submission_id}`,
        newDelivery.id!,
      );
    }

    return newDelivery;
  }

  /** (businessId:key) → id, the unique index of the real table. */
  private submissions = new Map<string, string>();

  async findDeliveryBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<Delivery | null> {
    const id = this.submissions.get(`${businessId}:${clientSubmissionId}`);

    return this.deliveries.find((delivery) => delivery.id === id) ?? null;
  }

  /**
   * The listing, with the Prisma query's semantics: tenant and driver scope,
   * each facet, the search (id, recipient, order code, NF-e key and number,
   * city, driver name and CNH — the last two from `driverDirectory`), the
   * sort spec with its (created_at desc, id desc) tiebreaker, paging after
   * sorting, and the grouped counts of the cards and filters. Names compare by
   * code point; Postgres uses the database collation.
   */
  async listDeliveries({
    page,
    pageSize,
    sort,
    order,
    ...requested
  }: ListDeliveriesProps): Promise<ListDeliveriesPage> {
    const { filters, periodApplied } = this.resolveDeliveryPeriod(requested);

    const matching = (except?: DeliveryFacet) =>
      this.deliveries.filter((delivery) =>
        this.matchesDeliveryList(delivery, filters, except),
      );

    const rows = matching();

    const shipperName = (delivery: Delivery) =>
      this.shipperNames.get(delivery.shipperId) ?? "";
    const driverName = (delivery: Delivery) =>
      (delivery.driverId &&
        this.driverDirectory.get(delivery.driverId)?.name) ||
      null;

    const key = sort ?? DELIVERY_SORT_FALLBACK.sort;
    const direction =
      (order ?? (sort ? "asc" : DELIVERY_SORT_FALLBACK.order)) === "asc"
        ? 1
        : -1;

    const time = (value: unknown) =>
      value ? new Date(value as string).getTime() : null;

    const valueOf: Record<
      DeliverySortKey,
      (d: Delivery) => string | number | null
    > = {
      created_at: (d) => time(d.created_at),
      updated_at: (d) => time(d.updated_at ?? d.created_at),
      recipient_name: (d) => d.recipient_name,
      // The enum's declaration order, as Postgres orders it.
      status: (d) => DELIVERY_LIST_STATUSES.indexOf(d.status),
      scheduled_date: (d) => time(d.scheduled_date),
      delivered_at: (d) => time(d.delivered_at),
      shipperName: (d) => shipperName(d),
      driverName: (d) => driverName(d),
      destination: (d) => d.city,
    };

    const compare = (x: string | number | null, y: string | number | null) => {
      // NULLS LAST both ways for the dates; Postgres puts nulls last in ASC
      // and first in DESC for a plain column (the driver's name).
      if (x === null || y === null) {
        if (x === y) return 0;
        const nullsLast =
          key === "scheduled_date" || key === "delivered_at" || direction === 1;
        return (x === null ? 1 : -1) * (nullsLast ? 1 : -1);
      }

      return (x < y ? -1 : x > y ? 1 : 0) * direction;
    };

    const tiebreak = (x: Delivery, y: Delivery) =>
      (time(y.created_at) ?? 0) - (time(x.created_at) ?? 0) ||
      ((y.id ?? "") < (x.id ?? "") ? -1 : (y.id ?? "") > (x.id ?? "") ? 1 : 0);

    const sorted = [...rows].sort(
      (x, y) => compare(valueOf[key](x), valueOf[key](y)) || tiebreak(x, y),
    );

    const skip = (page - 1) * pageSize;

    const group = (list: Delivery[], by: (d: Delivery) => string | null) => {
      const counts = new Map<string | null, number>();

      for (const delivery of list) {
        counts.set(by(delivery), (counts.get(by(delivery)) ?? 0) + 1);
      }

      return [...counts].map(([value, count]) => ({ value, count }));
    };

    const ownShippers = new Map(
      [...this.shipperNames].filter(([id]) =>
        this.deliveries.some(
          (d) => d.shipperId === id && d.businessId === filters.businessId,
        ),
      ),
    );

    const ownDrivers = new Map(
      [...this.driverDirectory]
        .filter(([id]) =>
          this.deliveries.some(
            (d) => d.driverId === id && d.businessId === filters.businessId,
          ),
        )
        .map(([id, entry]) => [id, entry.name]),
    );

    return {
      periodApplied,
      data: sorted
        .slice(skip, skip + pageSize)
        .map((delivery) => this.withListRelations(delivery)) as Delivery[],
      statusCounts: group(matching("status"), (d) => d.status),
      shipperOptions: catalogFacetOptions(
        group(matching("shipperId"), (d) => d.shipperId),
        filters.shipperIds,
        ownShippers,
      ),
      driverOptions: catalogFacetOptions(
        group(matching("driverId"), (d) => d.driverId ?? null),
        filters.driverIds,
        ownDrivers,
      ),
    };
  }

  /**
   * resolveDeliveryPeriod (delivery-search.ts), in memory: an exact id, order
   * code, NF-e key or NF number of the company (and scope) sets the period
   * aside; a term under three characters never counts as exact.
   */
  private resolveDeliveryPeriod<F extends DeliveryListFilters>(
    filters: F,
  ): { filters: F; periodApplied: boolean } {
    const hasPeriod = Boolean(filters.createdFrom || filters.createdTo);
    const term = filters.search?.trim().toLowerCase() ?? "";

    if (!hasPeriod || !term) return { filters, periodApplied: hasPeriod };

    const exact =
      [...term].length >= 3 &&
      this.deliveries.some(
        (delivery) =>
          delivery.businessId === filters.businessId &&
          (!filters.scopeDriverId ||
            delivery.driverId === filters.scopeDriverId) &&
          [
            delivery.id,
            delivery.code,
            delivery.invoice_key,
            delivery.invoice_number,
          ].some((value) => (value ?? "").toLowerCase() === term),
      );

    if (!exact) return { filters, periodApplied: true };

    return {
      filters: { ...filters, createdFrom: undefined, createdTo: undefined },
      periodApplied: false,
    };
  }

  /** deliveryListWhere, in memory. */
  private matchesDeliveryList(
    delivery: Delivery,
    filters: DeliveryListFilters,
    except?: DeliveryFacet,
  ): boolean {
    if (delivery.businessId !== filters.businessId) return false;

    if (filters.scopeDriverId && delivery.driverId !== filters.scopeDriverId) {
      return false;
    }

    // [createdFrom, createdTo), as the Prisma `where` reads created_at.
    const createdAt = new Date(delivery.created_at ?? 0).getTime();

    if (filters.createdFrom && createdAt < filters.createdFrom.getTime()) {
      return false;
    }

    if (filters.createdTo && createdAt >= filters.createdTo.getTime()) {
      return false;
    }

    if (
      filters.kinds?.length &&
      !filters.kinds.includes(delivery.kind ?? "DELIVERY")
    ) {
      return false;
    }

    if (
      except !== "status" &&
      filters.statuses?.length &&
      !filters.statuses.includes(delivery.status)
    ) {
      return false;
    }

    if (
      except !== "shipperId" &&
      filters.shipperIds?.length &&
      !filters.shipperIds.includes(delivery.shipperId)
    ) {
      return false;
    }

    if (
      except !== "driverId" &&
      filters.driverIds?.length &&
      !filters.driverIds.includes(delivery.driverId ?? "")
    ) {
      return false;
    }

    const term = filters.search?.trim().toLowerCase() ?? "";

    if (!term) return true;

    const driver = delivery.driverId
      ? this.driverDirectory.get(delivery.driverId)
      : undefined;

    return [
      delivery.id ?? "",
      delivery.recipient_name,
      delivery.code ?? "",
      delivery.invoice_key ?? "",
      delivery.invoice_number ?? "",
      delivery.city,
      driver?.name ?? "",
      driver?.cnh ?? "",
    ].some((value) => value.toLowerCase().includes(term));
  }

  async findDeliveryById(deliveryId: string): Promise<Delivery | null> {
    return this.deliveries.find((d) => d.id === deliveryId) ?? null;
  }

  /**
   * The detail screen's include, from the seams: the listing's relations,
   * the items, the import's source, the trail (newest first) and the
   * occurrences with their type's form. It used to return the bare row, so
   * a unit test of the detail never saw items, events or occurrences.
   */
  async findDeliveryDetailById(deliveryId: string): Promise<unknown | null> {
    const delivery = await this.findDeliveryById(deliveryId);

    if (!delivery) return null;

    const newestFirst = (a: { created_at: Date }, b: { created_at: Date }) =>
      b.created_at.getTime() - a.created_at.getTime();
    const user = (id?: string | null) =>
      id ? { id, name: this.reporterNames.get(id) ?? "" } : null;

    return {
      ...this.withListRelations(delivery),
      items: (this.deliveryItems.get(deliveryId) ?? []).map((item) => ({
        ...item,
        deliveryId,
      })),
      import:
        delivery.importId && this.importSources.has(delivery.importId)
          ? { source: this.importSources.get(delivery.importId) }
          : null,
      events: this.events
        .filter((event) => event.deliveryId === deliveryId)
        .sort(newestFirst)
        .map((event) => ({
          ...event,
          reportedBy: user(event.reportedById),
          reason: event.reasonId
            ? {
                id: event.reasonId,
                name: this.reasonNames.get(event.reasonId) ?? "",
              }
            : null,
        })),
      occurrences: this.occurrences
        .filter((occurrence) => occurrence.deliveryId === deliveryId)
        .sort(newestFirst)
        .map((occurrence) => ({
          ...occurrence,
          occurrenceType: {
            id: occurrence.occurrenceTypeId,
            name:
              this.occurrenceTypeNames.get(occurrence.occurrenceTypeId) ?? "",
            blocks_delivery:
              this.occurrenceTypeBlocking.get(occurrence.occurrenceTypeId) ===
              true,
            requires_authorization:
              this.occurrenceTypeRequiresAuthorization.get(
                occurrence.occurrenceTypeId,
              ) === true,
            form_fields:
              this.occurrenceTypeFormFields.get(occurrence.occurrenceTypeId) ??
              null,
            form_version:
              this.occurrenceTypeFormVersion.get(occurrence.occurrenceTypeId) ??
              1,
          },
          reportedBy: user(occurrence.reportedById),
          authorizedBy: user(occurrence.authorizedById),
        })),
      // `orderBy created_at desc, take 50`.
      chatMessages: this.chatMessages
        .filter((message) => message.deliveryId === deliveryId)
        .sort(newestFirst)
        .slice(0, 50)
        .map(({ deliveryId: _deliveryId, ...message }) => message),
    };
  }

  /** listInclude: the shipper, the driver (with CNH) and the vehicle. */
  private withListRelations(delivery: Delivery) {
    return {
      ...delivery,
      shipper: {
        id: delivery.shipperId,
        name: this.shipperNames.get(delivery.shipperId) ?? "",
      },
      driver: delivery.driverId
        ? {
            id: delivery.driverId,
            name: this.driverDirectory.get(delivery.driverId)?.name ?? "",
            cnh: this.driverDirectory.get(delivery.driverId)?.cnh ?? "",
          }
        : null,
      vehicle: delivery.vehicleId
        ? {
            id: delivery.vehicleId,
            license_plate: this.vehiclePlates.get(delivery.vehicleId) ?? "",
          }
        : null,
    };
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
    expectedStatus?: DeliveryStatus,
  ): Promise<Delivery> {
    // Mirrors the real `where` precondition: otherwise the twin accepts
    // writes the repository refuses, and a race test proves nothing.
    const index = this.deliveries.findIndex(
      (d) =>
        d.id === deliveryId && (!expectedStatus || d.status === expectedStatus),
    );

    if (index === -1) {
      throw new DeliveryStatusConflictError();
    }

    const { items, ...fields } = deliveryData;

    const filteredData = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );

    if (deliveryData.scheduled_date !== undefined) {
      filteredData.scheduled_date = asDateColumn(deliveryData.scheduled_date);
    }

    if (
      typeof filteredData.invoice_key === "string" &&
      this.deliveries.some(
        (other) =>
          other.id !== deliveryId &&
          other.businessId === this.deliveries[index].businessId &&
          other.invoice_key === filteredData.invoice_key,
      )
    ) {
      throw uniqueViolation(["businessId", "invoice_key"]);
    }

    this.deliveries[index] = {
      ...this.deliveries[index],
      ...filteredData,
      updated_at: new Date(),
    };

    if (items !== undefined)
      this.deliveryItems.set(deliveryId, asStoredItems(items));

    return this.deliveries[index];
  }

  async findOpenStopRoute(
    deliveryId: string,
  ): Promise<{ routeId: string; status: string } | null> {
    const stop = this.routeStops.find(
      (entry) =>
        entry.deliveryId === deliveryId &&
        (entry.status === "PENDING" || entry.status === "ARRIVED"),
    );

    // A stop always belongs to a route in Postgres (NOT NULL FK); a seed
    // without one is not a stop the real read could return.
    if (!stop?.routeId) return null;

    const status = stop.routeStatus ?? this.routeStatusOf(stop.routeId);

    return status ? { routeId: stop.routeId, status } : null;
  }

  /**
   * The route table this twin does not own: a test that shares the route
   * twin's stops wires this to it, so the stop's route status is the real one.
   */
  public routeStatusOf: (routeId: string) => string | null = () => null;

  async findDeliveryImportSource(
    deliveryId: string,
  ): Promise<"SPREADSHEET" | "NFE_XML" | null> {
    const delivery = this.deliveries.find((d) => d.id === deliveryId);

    if (!delivery?.importId) return null;

    return this.importSources.get(delivery.importId) ?? null;
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
  ): Promise<{ id: string }> {
    // The unique index on client_submission_id, as Postgres enforces it.
    if (
      occurrenceData.client_submission_id &&
      this.occurrences.some(
        (occurrence) =>
          occurrence.client_submission_id ===
          occurrenceData.client_submission_id,
      )
    ) {
      throw uniqueViolation(["client_submission_id"]);
    }

    // tenantOfDelivery: findUniqueOrThrow, P2025 for a delivery that is not there.
    const delivery = this.deliveries.find(
      (row) => row.id === occurrenceData.deliveryId,
    );

    if (!delivery) throw recordNotFound("update");

    const id = uuidV7();
    const now = new Date();

    this.occurrences.push({
      ...withColumnDefaults(
        DELIVERY_OCCURRENCE_COLUMN_DEFAULTS,
        occurrenceData,
      ),
      // As the Prisma create: the delivery's tenant copied, empty text NULL.
      businessId: delivery.businessId,
      description: occurrenceData.description || null,
      latitude: occurrenceData.latitude ?? null,
      longitude: occurrenceData.longitude ?? null,
      photos: occurrenceData.photos ?? [],
      // No answers is SQL NULL, as the Prisma write stores it.
      form_answers: occurrenceData.form_answers ?? null,
      // created_at and @updatedAt, as the INSERT gets them.
      id,
      created_at: now,
      updated_at: now,
    });

    return { id };
  }

  async findOccurrenceBySubmissionId(
    clientSubmissionId: string,
    businessId: string,
  ): Promise<{
    id: string;
    authorization_status: OccurrenceAuthorizationStatus;
    category: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";
  } | null> {
    // Scoped here too: a twin that accepts `businessId` and ignores it
    // type-checks and keeps a unit test green over a cross-tenant leak.
    const found = this.occurrences.find(
      (occurrence) =>
        occurrence.client_submission_id === clientSubmissionId &&
        this.deliveries.some(
          (delivery) =>
            delivery.id === occurrence.deliveryId &&
            delivery.businessId === businessId,
        ),
    );

    return found
      ? {
          id: found.id,
          // A row pushed straight into the array by a test has no status:
          // the column default.
          authorization_status: found.authorization_status ?? "NOT_REQUIRED",
          category: found.category ?? "NOT_DELIVERED",
        }
      : null;
  }

  /**
   * The Prisma query's semantics over the arrays: tenant through the
   * delivery, the same filters and search fields (search as a literal,
   * case-insensitive substring, like the escaped ILIKE), the same order with
   * its (created_at desc, id desc) tiebreaker, the row shape of the
   * `include`, and type counts limited to the company's own types. Names
   * compare by code point; Postgres uses the database collation, so accents
   * may order differently there.
   */
  async listOccurrences({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListOccurrencesProps): Promise<ListOccurrencesResult> {
    const deliveriesById = new Map(
      this.deliveries.map((delivery) => [delivery.id, delivery]),
    );

    const typeOf = (typeId: string) => ({
      id: typeId,
      name: this.occurrenceTypeNames.get(typeId) ?? "Tipo de ocorrência",
      blocks_delivery: this.occurrenceTypeBlocking.get(typeId) === true,
      category: this.occurrenceTypeCategory.get(typeId) ?? "NOT_DELIVERED",
    });

    // The Prisma lookup reads names with businessId in the where: another
    // tenant's type (or one this store never saw) resolves to nothing.
    const isCompanyType = (typeId: string) =>
      this.occurrenceTypeBusiness.get(typeId) === filters.businessId;

    const term = filters.search?.trim().toLowerCase() ?? "";
    const blocking = severityAsBlocking(filters.severity);
    const category = selectedCategory(filters.category);

    const inBase = this.occurrences.filter((occurrence) => {
      const delivery = deliveriesById.get(occurrence.deliveryId);

      if (!delivery || delivery.businessId !== filters.businessId) return false;
      if (filters.driverId && delivery.driverId !== filters.driverId) {
        return false;
      }

      if (
        filters.deliveryStatuses?.length &&
        !filters.deliveryStatuses.includes(delivery.status)
      ) {
        return false;
      }

      if (!term) return true;

      return [
        occurrence.id,
        occurrence.deliveryId,
        delivery.recipient_name,
        typeOf(occurrence.occurrenceTypeId).name,
      ].some((value) => value.toLowerCase().includes(term));
    });

    const matching = inBase.filter((occurrence) => {
      if (
        filters.occurrenceTypeIds?.length &&
        !filters.occurrenceTypeIds.includes(occurrence.occurrenceTypeId)
      ) {
        return false;
      }

      // The row's own category column, as the Prisma where reads it.
      const rowCategory = occurrence.category ?? "NOT_DELIVERED";

      if (category && rowCategory !== category) return false;

      return (
        blocking === undefined ||
        (rowCategory === "NOT_DELIVERED" &&
          typeOf(occurrence.occurrenceTypeId).blocks_delivery === blocking)
      );
    });

    const rows = matching.map((occurrence) => {
      const delivery = deliveriesById.get(occurrence.deliveryId)!;

      return {
        ...occurrence,
        businessId: delivery.businessId,
        occurrenceType: {
          ...typeOf(occurrence.occurrenceTypeId),
          requires_photo:
            this.occurrenceTypeRequiresPhoto.get(
              occurrence.occurrenceTypeId,
            ) === true,
        },
        reportedBy: {
          id: occurrence.reportedById,
          name: this.reporterNames.get(occurrence.reportedById) ?? "Usuário",
        },
        delivery: {
          id: delivery.id!,
          recipient_name: delivery.recipient_name,
          status: delivery.status,
          city: delivery.city,
          uf: delivery.uf,
          code: delivery.code ?? null,
        },
      };
    });

    type Row = (typeof rows)[number];

    const sortValue: Record<OccurrenceSortKey, (row: Row) => OrderValue> = {
      created_at: (row) => row.created_at,
      typeName: (row) => row.occurrenceType.name,
      blocking: (row) => row.occurrenceType.blocks_delivery,
      recipient: (row) => row.delivery.recipient_name,
      reporter: (row) => row.reportedBy.name,
    };

    const key = sort ?? OCCURRENCE_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : OCCURRENCE_SORT_FALLBACK.order);

    rows.sort(
      (a, b) =>
        compareForOrder(sortValue[key](a), sortValue[key](b), direction) ||
        compareForOrder(a.created_at, b.created_at, "desc") ||
        compareForOrder(a.id, b.id, "desc"),
    );

    const counts = new Map<string, number>();

    for (const occurrence of inBase) {
      if (!isCompanyType(occurrence.occurrenceTypeId)) continue;

      counts.set(
        occurrence.occurrenceTypeId,
        (counts.get(occurrence.occurrenceTypeId) ?? 0) + 1,
      );
    }

    // A selected type of the company stays listed with 0, as the Prisma
    // lookup keeps it; a foreign one never comes back, name included.
    for (const typeId of filters.occurrenceTypeIds ?? []) {
      if (isCompanyType(typeId) && !counts.has(typeId)) counts.set(typeId, 0);
    }

    const skip = (page - 1) * pageSize;

    return {
      data: rows.slice(skip, skip + pageSize),
      typeCounts: [...counts].map(([typeId, count]) => ({
        ...typeOf(typeId),
        count,
      })),
    };
  }

  async operationBacklog(
    businessId: string,
    day: OperationDay,
  ): Promise<OperationBacklog> {
    const inDay = (value: Date): boolean =>
      value.getTime() >= day.start.getTime() &&
      value.getTime() < day.end.getTime();

    // PENDING without a driver, of any date (see the Prisma repository).
    const unassigned = this.deliveries.filter(
      (delivery) =>
        delivery.businessId === businessId &&
        delivery.status === "PENDING" &&
        !delivery.driverId,
    ).length;

    // The twin's occurrence rows carry no businessId: the delivery's is the
    // occurrence's, as the table's writes keep them.
    const deliveriesById = new Map(
      this.deliveries.map((delivery) => [delivery.id, delivery]),
    );

    // Driver reports only, by when they happened; the SQL's
    // `created_at >= start` is implied, a fact is never after its arrival.
    const occurrencesToday = this.occurrences.filter(
      (occurrence) =>
        deliveriesById.get(occurrence.deliveryId)?.businessId === businessId &&
        this.driverUserIds.has(occurrence.reportedById) &&
        this.occurrenceTypeSystem.get(occurrence.occurrenceTypeId) !== true &&
        (occurrence.category ?? "NOT_DELIVERED") === "NOT_DELIVERED" &&
        inDay(
          factInstant(occurrence.occurred_at ?? null, occurrence.created_at),
        ),
    ).length;

    return { unassigned, occurrencesToday };
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
          // D8 (design §4.13), as the real where: on the street, or waiting
          // on an open stop of a RELEASED / IN_PROGRESS route.
          (delivery.status === "IN_TRANSIT" ||
            (delivery.status === "PENDING" &&
              this.routeStops.some(
                (stop) =>
                  stop.deliveryId === delivery.id &&
                  (stop.status === "PENDING" || stop.status === "ARRIVED") &&
                  (stop.routeStatus === "RELEASED" ||
                    stop.routeStatus === "IN_PROGRESS"),
              ))),
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

        authorization_request: this.latestAuthorizationRequest(
          delivery.id!,
          driverId,
        ),
      }));
  }

  /**
   * The delivery's newest report that asked the tower, in the Prisma
   * mapping's shape (created_at desc, id desc as the tiebreaker).
   */
  private latestAuthorizationRequest(deliveryId: string, driverId: string) {
    const latest = this.occurrences
      .filter(
        (occurrence) =>
          occurrence.deliveryId === deliveryId &&
          (occurrence.authorization_status ?? "NOT_REQUIRED") !==
            "NOT_REQUIRED" &&
          // reportedBy.driverId = driverId: only this driver's own request.
          this.driverOfUser.get(occurrence.reportedById) === driverId,
      )
      .sort(
        (a, b) =>
          b.created_at.getTime() - a.created_at.getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )[0];

    if (!latest) return null;

    return {
      occurrenceId: latest.id,
      occurrenceTypeId: latest.occurrenceTypeId,
      occurrenceTypeName:
        this.occurrenceTypeNames.get(latest.occurrenceTypeId) ??
        "Tipo de ocorrência",
      status: latest.authorization_status!,
      note: latest.authorization_note ?? null,
      decidedAt: latest.authorized_at ?? null,
      requestedAt: latest.created_at,
    };
  }

  /**
   * Created at or before `createdUpTo`, as the real `created_at <=` filter.
   * A row seeded without a creation time counts as old: in Postgres the
   * column always has one, and a fake that dropped such rows would hide the
   * batch from every test that never set it.
   */
  private createdBy(delivery: Delivery, createdUpTo?: Date): boolean {
    if (!createdUpTo || !delivery.created_at) return true;

    return new Date(delivery.created_at).getTime() <= createdUpTo.getTime();
  }

  async countPendingForDriver(
    businessId: string,
    driverId: string,
    createdUpTo?: Date,
  ): Promise<number> {
    return this.deliveries.filter(
      (delivery) =>
        delivery.businessId === businessId &&
        delivery.driverId === driverId &&
        delivery.status === "PENDING" &&
        !this.onAnOpenStop(delivery.id) &&
        this.createdBy(delivery, createdUpTo),
    ).length;
  }

  async startDriverRoute(
    businessId: string,
    driverId: string,
    createdUpTo?: Date,
  ): Promise<number> {
    const pending = this.deliveries.filter(
      (delivery) =>
        delivery.businessId === businessId &&
        delivery.driverId === driverId &&
        delivery.status === "PENDING" &&
        // A delivery on a route leaves with that route. Without this the old
        // batch departure would drag an unreleased plan onto the street.
        !this.onAnOpenStop(delivery.id) &&
        // A tap sent late moves only what existed when it was made.
        this.createdBy(delivery, createdUpTo),
    );

    for (const delivery of pending) {
      delivery.status = "IN_TRANSIT";
    }

    return pending.length;
  }

  async findEventBySubmissionId(
    clientSubmissionId: string,
    businessId: string,
  ): Promise<DeliveryEventRecord | null> {
    const found = this.events.find(
      (event) =>
        event.client_submission_id === clientSubmissionId &&
        this.deliveries.some(
          (delivery) =>
            delivery.id === event.deliveryId &&
            delivery.businessId === businessId,
        ),
    );

    if (!found) return null;

    return {
      id: found.id,
      type: found.type,
      deliveryId: found.deliveryId,
      // The record type says "null when there is none"; the create props say
      // "may be absent". An event written by the web has no submission id at
      // all, so the two shapes meet here.
      client_submission_id: found.client_submission_id ?? null,
    };
  }

  async findDeliveryByShipperAndCode(
    businessId: string,
    shipperId: string,
    code: string,
  ): Promise<Delivery | null> {
    return (
      this.deliveries.find(
        (delivery) =>
          delivery.businessId === businessId &&
          delivery.shipperId === shipperId &&
          delivery.code === code,
      ) ?? null
    );
  }

  // A no-op: the race it closes needs two connections, so it is proven against
  // Postgres (tests/E2E/import-order-concurrency.test.ts), not here.
  async lockOrderIdentity(): Promise<void> {}

  /** The listing's filters (deliveryListWhere), in creation order. */
  /** The listing's filters, in (created_at, id) order, through the shared row. */
  async *streamDeliveriesForExport(
    requested: DeliveryListFilters,
  ): AsyncGenerator<Record<string, unknown>> {
    const { filters } = this.resolveDeliveryPeriod(requested);

    const rows = this.deliveries
      .filter((delivery) => this.matchesDeliveryList(delivery, filters))
      .sort(byCreationThenId);

    for (const delivery of rows) {
      // `stops orderBy created_at desc take 1`: the latest stop's route.
      const latestStop = this.routeStops
        .filter((stop) => stop.deliveryId === delivery.id)
        .sort(
          (a, b) =>
            (b.created_at?.getTime() ?? 0) - (a.created_at?.getTime() ?? 0),
        )[0];

      yield deliveryExportRow(delivery, {
        shipperName: this.shipperNames.get(delivery.shipperId) ?? null,
        driverName: delivery.driverId
          ? (this.driverDirectory.get(delivery.driverId)?.name ?? null)
          : null,
        vehiclePlate: delivery.vehicleId
          ? (this.vehiclePlates.get(delivery.vehicleId) ?? null)
          : null,
        routeCode: latestStop?.routeId
          ? (this.routeCodes.get(latestStop.routeId) ?? null)
          : null,
      });
    }
  }

  /** The feed's filters (occurrenceFeedWhere with the type facets). */
  async *streamOccurrencesForExport(
    filters: OccurrenceFeedFilters,
  ): AsyncGenerator<Record<string, unknown>> {
    const deliveriesById = new Map(
      this.deliveries.map((delivery) => [delivery.id, delivery]),
    );

    const term = filters.search?.trim().toLowerCase() ?? "";
    const blocking = severityAsBlocking(filters.severity);
    const category = selectedCategory(filters.category);

    for (const occurrence of [...this.occurrences].sort(byCreationThenId)) {
      const delivery = deliveriesById.get(occurrence.deliveryId);

      if (!delivery || delivery.businessId !== filters.businessId) continue;
      if (filters.driverId && delivery.driverId !== filters.driverId) continue;

      if (
        filters.deliveryStatuses?.length &&
        !filters.deliveryStatuses.includes(delivery.status)
      ) {
        continue;
      }

      if (
        filters.occurrenceTypeIds?.length &&
        !filters.occurrenceTypeIds.includes(occurrence.occurrenceTypeId)
      ) {
        continue;
      }

      const rowCategory = occurrence.category ?? "NOT_DELIVERED";

      if (category && rowCategory !== category) continue;

      if (
        blocking !== undefined &&
        (rowCategory !== "NOT_DELIVERED" ||
          (this.occurrenceTypeBlocking.get(occurrence.occurrenceTypeId) ===
            true) !==
            blocking)
      ) {
        continue;
      }

      if (
        term &&
        ![
          occurrence.id,
          occurrence.deliveryId,
          delivery.recipient_name,
          this.occurrenceTypeNames.get(occurrence.occurrenceTypeId) ?? "",
        ].some((value) => value.toLowerCase().includes(term))
      ) {
        continue;
      }

      // The same row the Prisma export writes; names come from the seams.
      yield occurrenceExportRow(
        { ...occurrence, category: rowCategory },
        {
          typeName:
            this.occurrenceTypeNames.get(occurrence.occurrenceTypeId) ?? null,
          blocksDelivery:
            this.occurrenceTypeBlocking.get(occurrence.occurrenceTypeId) ===
            true,
          formFields:
            this.occurrenceTypeFormFields.get(occurrence.occurrenceTypeId) ??
            null,
          delivery: {
            id: delivery.id!,
            recipient_name: delivery.recipient_name,
            city: delivery.city,
            uf: delivery.uf,
          },
          reporterName: this.reporterNames.get(occurrence.reportedById) ?? null,
          deciderName: occurrence.authorizedById
            ? (this.reporterNames.get(occurrence.authorizedById) ?? null)
            : null,
        },
      );
    }
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
    // tenantOfDelivery: P2025 for a delivery that is not there.
    const delivery = this.deliveries.find(
      (row) => row.id === eventData.deliveryId,
    );

    if (!delivery) throw recordNotFound("update");

    // client_submission_id is @unique on the whole table.
    if (
      eventData.client_submission_id &&
      this.events.some(
        (event) =>
          event.client_submission_id === eventData.client_submission_id,
      )
    ) {
      throw uniqueViolation(["client_submission_id"]);
    }

    this.events.push({
      ...withColumnDefaults(DELIVERY_EVENT_COLUMN_DEFAULTS, eventData),
      businessId: delivery.businessId,
      actor: eventData.actor ?? "USER",
      reportedById: eventData.reportedById ?? null,
      reasonId: eventData.reasonId ?? null,
      note: eventData.note ?? null,
      // A nullable column the Prisma write always sets: null, not undefined.
      routeId: eventData.routeId ?? null,
      id: uuidV7(),
      created_at: new Date(),
    });
  }

  async registerDeliveryProof(
    eventData: CreateDeliveryEventProps,
    expectedStatus: DeliveryStatus,
  ): Promise<string[]> {
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

    this.events.push({
      ...withColumnDefaults(DELIVERY_EVENT_COLUMN_DEFAULTS, eventData),
      type: "PROOF",
      id: uuidV7(),
      created_at: new Date(),
    });

    delivery.status = "DELIVERED";
    delivery.delivered_at = eventData.occurred_at ?? new Date();
    delivery.received_by = eventData.received_by ?? null;

    // Decision 6.3, as the Prisma write: the proof supersedes what still
    // waits for the tower, and says which.
    const superseded: string[] = [];

    for (const occurrence of this.occurrences) {
      if (
        occurrence.deliveryId === eventData.deliveryId &&
        occurrence.authorization_status === "PENDING"
      ) {
        occurrence.authorization_status = "SUPERSEDED";
        occurrence.updated_at = new Date();
        superseded.push(occurrence.id);
      }
    }

    return superseded;
  }
}

export { InMemoryDeliveryRepository };
