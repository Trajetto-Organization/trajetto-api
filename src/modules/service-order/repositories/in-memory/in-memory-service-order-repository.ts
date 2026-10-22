import { afterCursor, newestFirst } from "@/shared/in-memory/cursor";
import {
  recordNotFound,
  uniqueViolation,
} from "@/shared/in-memory/prisma-errors";
import { v7 as uuidV7 } from "uuid";
import { IServiceOrderRepository } from "../IService-order-repository";

import {
  ServiceOrder,
  CreateServiceOrderProps,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  UpdateServiceOrder,
  SearchServiceOrderWithCursorProps,
  SearchServiceOrderByVehicleWithCursorProps,
  CursorPaginatedServiceOrder,
  ServiceOrderListQuery,
  DeleteServiceOrderResult,
} from "../../dtos/service-order-dto";

import {
  MAINTENANCE_TYPES,
  SERVICE_ORDER_SORT_FALLBACK,
  SERVICE_ORDER_STATUSES,
  partsTotalOf,
  type ServiceOrderSortKey,
  type ServiceOrderStatus,
} from "../../usecases/list-service-order/service-order-list";

/** A part line of an order, as the real table's cascade and totals see it. */
interface ServiceOrderPartSeed {
  serviceOrderId: string;
  unit_price: number;
  quantity: number;
  discount_percentage?: number | null;
}

/**
 * The twin of ServiceOrderRepository. It has no joined tables, so what the
 * real list reads from them (plate, names, parts, bills) comes from the seeds
 * below; the semantics — tenant, facets, search, order, paging, counts — are
 * the real repository's.
 */
class InMemoryServiceOrderRepository implements IServiceOrderRepository {
  public serviceOrders: ServiceOrder[] = [];

  /** vehicleId → what the list joins from the vehicle. */
  public vehicles = new Map<
    string,
    { license_plate: string; description: string }
  >();

  /** userId / branchId / supplierId → name, as the list joins them. */
  public userNames = new Map<string, string>();
  public branchNames = new Map<string, string>();
  public supplierNames = new Map<string, string>();

  public parts: ServiceOrderPartSeed[] = [];

  /** Bills pointing at an order (account_payable.serviceOrderId). */
  public accountsPayable: Array<{ serviceOrderId: string }> = [];

  async createServiceOrder(
    serviceOrderData: CreateServiceOrderProps,
  ): Promise<ServiceOrder> {
    // The (businessId, client_submission_id) unique index: a replayed key is
    // P2002, as in Postgres. It used to overwrite the key's owner here.
    if (
      serviceOrderData.client_submission_id &&
      this.submissions.has(
        `${serviceOrderData.businessId}:${serviceOrderData.client_submission_id}`,
      )
    ) {
      throw uniqueViolation(["businessId", "client_submission_id"]);
    }

    const serviceOrder: ServiceOrder = {
      id: uuidV7(),
      date: serviceOrderData.date,
      completion_date: serviceOrderData.completion_date ?? null,
      maintenance_type: serviceOrderData.maintenance_type,
      total_amount: serviceOrderData.total_amount.toString(),
      // Prisma returns null for an omitted nullable column, not undefined.
      description: serviceOrderData.description ?? null,
      businessId: serviceOrderData.businessId,
      vehicleId: serviceOrderData.vehicleId,
      responsibleUserId: serviceOrderData.responsibleUserId,
      branchId: serviceOrderData.branchId,
      supplierId: serviceOrderData.supplierId ?? null,
      current_mileage_at_service: serviceOrderData.current_mileage_at_service,
      maintenance_interval_km_at_service:
        serviceOrderData.maintenance_interval_km_at_service,
      last_maintenance_mileage_at_service:
        serviceOrderData.last_maintenance_mileage_at_service,
      new_mileage_after_service: serviceOrderData.new_mileage_after_service,
      // Geolocation fields
      // `?? null`: a 0 coordinate is a coordinate (`|| null` erased it).
      latitude: serviceOrderData.latitude ?? null,
      longitude: serviceOrderData.longitude ?? null,
      latitude_original: serviceOrderData.latitude_original ?? null,
      longitude_original: serviceOrderData.longitude_original ?? null,
      location_source: serviceOrderData.location_source ?? null,
      location_edited_by: null,
      location_edited_at: null,
      created_from: serviceOrderData.created_from,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.serviceOrders.push(serviceOrder);

    if (serviceOrderData.client_submission_id) {
      this.submissions.set(
        `${serviceOrderData.businessId}:${serviceOrderData.client_submission_id}`,
        serviceOrder.id,
      );
    }

    return serviceOrder;
  }

  /** (businessId:key) → id, the unique index of the real table. */
  private submissions = new Map<string, string>();

  async findServiceOrderBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<ServiceOrder | null> {
    const id = this.submissions.get(`${businessId}:${clientSubmissionId}`);

    return this.serviceOrders.find((order) => order.id === id) ?? null;
  }

  private statusOf(order: ServiceOrder): ServiceOrderStatus {
    return order.completion_date ? "completed" : "open";
  }

  /** The real where: tenant first, then facets and the search (substring, any case). */
  private matches(
    order: ServiceOrder,
    query: ServiceOrderListQuery,
    except: Array<"status" | "maintenanceType" | "branch"> = [],
  ): boolean {
    if (order.businessId !== query.businessId) return false;

    const statuses = new Set(query.statuses ?? []);

    if (
      !except.includes("status") &&
      statuses.size === 1 &&
      !statuses.has(this.statusOf(order))
    ) {
      return false;
    }

    if (
      !except.includes("maintenanceType") &&
      query.maintenanceTypes?.length &&
      !query.maintenanceTypes.includes(order.maintenance_type)
    ) {
      return false;
    }

    if (
      !except.includes("branch") &&
      query.branchIds?.length &&
      !query.branchIds.includes(order.branchId)
    ) {
      return false;
    }

    const term = query.search?.trim().toLowerCase();

    if (!term) return true;

    const vehicle = this.vehicles.get(order.vehicleId);
    const numeric = Number(term.replace(",", "."));

    const texts = [
      order.id,
      order.description ?? "",
      vehicle?.license_plate ?? "",
      vehicle?.description ?? "",
      this.userNames.get(order.responsibleUserId) ?? "",
      this.branchNames.get(order.branchId) ?? "",
      order.supplierId ? (this.supplierNames.get(order.supplierId) ?? "") : "",
    ];

    return (
      texts.some((text) => text.toLowerCase().includes(term)) ||
      (Number.isFinite(numeric) &&
        /\d/.test(term) &&
        Number(order.total_amount) === numeric)
    );
  }

  private sortValue(
    order: ServiceOrder,
    key: ServiceOrderSortKey,
  ): string | number | null {
    const time = (value: Date | string | null | undefined) =>
      value ? new Date(value).getTime() : null;

    switch (key) {
      case "created_at":
        return time(order.created_at);
      case "updated_at":
        return time(order.updated_at);
      case "date":
        return time(order.date);
      case "completion_date":
        return time(order.completion_date);
      case "total_amount":
        return Number(order.total_amount);
      case "maintenance_type":
        return order.maintenance_type;
      case "vehicleLicensePlate":
        return this.vehicles.get(order.vehicleId)?.license_plate ?? null;
      case "responsibleUserName":
        return this.userNames.get(order.responsibleUserId) ?? null;
      case "supplierName":
        return order.supplierId
          ? (this.supplierNames.get(order.supplierId) ?? null)
          : null;
      case "branchName":
        return this.branchNames.get(order.branchId) ?? null;
    }
  }

  async listServiceOrders({
    page,
    pageSize,
    sort,
    order,
    ...query
  }: ListServiceOrderByBusinessIdProps): Promise<ListServiceOrderProps> {
    const key = sort ?? SERVICE_ORDER_SORT_FALLBACK.sort;
    const direction =
      (order ?? (sort ? "asc" : SERVICE_ORDER_SORT_FALLBACK.order)) === "asc"
        ? 1
        : -1;

    // Postgres: NULLs sort as larger than any value (last ascending, first
    // descending), which is Prisma's default too.
    const compare = (a: string | number | null, b: string | number | null) => {
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;

      return a < b ? -1 : 1;
    };

    const time = (value: Date | string) => new Date(value).getTime();

    const rows = this.serviceOrders
      .filter((entry) => this.matches(entry, query))
      .sort(
        (a, b) =>
          direction * compare(this.sortValue(a, key), this.sortValue(b, key)) ||
          compare(time(b.created_at), time(a.created_at)) ||
          compare(b.id, a.id),
      );

    const skip = (page - 1) * pageSize;

    const data = rows.slice(skip, skip + pageSize).map((entry) => {
      const parts = this.parts.filter(
        (part) => part.serviceOrderId === entry.id,
      );

      return {
        ...entry,
        parts_total: partsTotalOf(parts),
        parts_count: parts.length,
        accounts_payable_count: this.accountsPayable.filter(
          (bill) => bill.serviceOrderId === entry.id,
        ).length,
      };
    });

    const base = this.serviceOrders.filter((entry) =>
      this.matches(entry, query, ["status", "maintenanceType"]),
    );

    const cells = SERVICE_ORDER_STATUSES.flatMap((status) =>
      MAINTENANCE_TYPES.map((type) => {
        const inCell = base.filter(
          (entry) =>
            this.statusOf(entry) === status && entry.maintenance_type === type,
        );

        return {
          status,
          maintenance_type: type,
          count: inCell.length,
          totalAmount: inCell.reduce(
            (total, entry) => total + Number(entry.total_amount),
            0,
          ),
        };
      }),
    ).filter((cell) => cell.count > 0);

    const byBranch = new Map<string, number>();

    for (const entry of this.serviceOrders.filter((row) =>
      this.matches(row, query, ["branch"]),
    )) {
      byBranch.set(entry.branchId, (byBranch.get(entry.branchId) ?? 0) + 1);
    }

    // Like the real one: only branches of this company get a name; a
    // selected branch with nothing left keeps its chip with a zero.
    const companyBranches = new Set(
      this.serviceOrders
        .filter((entry) => entry.businessId === query.businessId)
        .map((entry) => entry.branchId),
    );

    const branchIds = Array.from(
      new Set([...byBranch.keys(), ...(query.branchIds ?? [])]),
    ).filter((id) => companyBranches.has(id) && this.branchNames.has(id));

    const branchCounts = branchIds
      .map((id) => ({
        value: id,
        label: this.branchNames.get(id) as string,
        count: byBranch.get(id) ?? 0,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));

    return { data, cells, branchCounts };
  }

  async updateServiceOrder({
    serviceOrderData,
    serviceOrderId,
  }: UpdateServiceOrder): Promise<ServiceOrder> {
    const index = this.serviceOrders.findIndex(
      (order) => order.id === serviceOrderId,
    );

    if (index === -1) {
      throw recordNotFound("update");
    }

    const updatedOrder: ServiceOrder = {
      ...this.serviceOrders[index],
      updated_at: new Date(),
    };

    // Only update fields that exist in UpdateServiceOrderProps
    if (serviceOrderData.date !== undefined) {
      updatedOrder.date = serviceOrderData.date as string | Date;
    }

    if (serviceOrderData.completion_date !== undefined) {
      updatedOrder.completion_date = serviceOrderData.completion_date;
    }

    if (serviceOrderData.maintenance_type !== undefined) {
      updatedOrder.maintenance_type = serviceOrderData.maintenance_type;
    }

    if (serviceOrderData.total_amount !== undefined) {
      updatedOrder.total_amount = serviceOrderData.total_amount.toString();
    }

    if (serviceOrderData.description !== undefined) {
      updatedOrder.description = serviceOrderData.description;
    }

    if (serviceOrderData.new_mileage_after_service !== undefined) {
      updatedOrder.new_mileage_after_service =
        serviceOrderData.new_mileage_after_service;
    }

    if (serviceOrderData.vehicleId !== undefined) {
      updatedOrder.vehicleId = serviceOrderData.vehicleId;
    }

    if (serviceOrderData.responsibleUserId !== undefined) {
      updatedOrder.responsibleUserId = serviceOrderData.responsibleUserId;
    }

    if (serviceOrderData.branchId !== undefined) {
      updatedOrder.branchId = serviceOrderData.branchId;
    }

    if (serviceOrderData.supplierId !== undefined) {
      updatedOrder.supplierId = serviceOrderData.supplierId;
    }

    this.serviceOrders[index] = updatedOrder;
    return this.serviceOrders[index];
  }

  async deleteServiceOrderGuarded(
    serviceOrderId: string,
    businessId: string,
  ): Promise<DeleteServiceOrderResult> {
    const index = this.serviceOrders.findIndex(
      (order) => order.id === serviceOrderId && order.businessId === businessId,
    );

    if (index === -1) return { missing: true };

    const target = this.serviceOrders[index];

    const accountsPayable = this.accountsPayable.filter(
      (bill) => bill.serviceOrderId === serviceOrderId,
    ).length;

    const completed = Boolean(target.completion_date);

    if (completed || accountsPayable > 0) {
      return { blocked: { completed, accountsPayable } };
    }

    // The parts go with the order: ON DELETE CASCADE in the real table.
    const partsRemoved = this.parts.filter(
      (part) => part.serviceOrderId === serviceOrderId,
    ).length;

    this.parts = this.parts.filter(
      (part) => part.serviceOrderId !== serviceOrderId,
    );

    this.serviceOrders.splice(index, 1);

    return { deleted: target, partsRemoved };
  }

  async findServiceOrderById(
    serviceOrderId: string,
  ): Promise<ServiceOrder | null> {
    const serviceOrder = this.serviceOrders.find(
      (order) => order.id === serviceOrderId,
    );

    return serviceOrder || null;
  }

  async findServiceOrdersByVehicleId(
    vehicleId: string,
  ): Promise<ServiceOrder[] | null> {
    const orders = this.serviceOrders.filter(
      (order) => order.vehicleId === vehicleId,
    );

    // findMany answers [] when there is none, never null.
    return orders;
  }

  async findServiceOrdersByResponsibleUserId(
    responsibleUserId: string,
  ): Promise<ServiceOrder[]> {
    return this.serviceOrders.filter(
      (order) => order.responsibleUserId === responsibleUserId,
    );
  }

  async *streamServiceOrdersForExport(
    query: ServiceOrderListQuery,
  ): AsyncGenerator<any> {
    // The real one pages by id ascending over the listing's where.
    const filtered = this.serviceOrders
      .filter((order) => this.matches(order, query))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const order of filtered) {
      const vehicle = this.vehicles.get(order.vehicleId);

      yield {
        id: order.id,
        date: order.date,
        completion_date: order.completion_date,
        maintenance_type: order.maintenance_type,
        total_amount: Number(order.total_amount),
        parts_total: partsTotalOf(
          this.parts.filter((part) => part.serviceOrderId === order.id),
        ),
        description: order.description ?? null,
        current_mileage_at_service: order.current_mileage_at_service,
        maintenance_interval_km_at_service:
          order.maintenance_interval_km_at_service,
        last_maintenance_mileage_at_service:
          order.last_maintenance_mileage_at_service,
        new_mileage_after_service: order.new_mileage_after_service,
        businessId: order.businessId,
        businessName: null,
        vehicleId: order.vehicleId,
        vehicleLicensePlate: vehicle?.license_plate ?? null,
        vehicleDescription: vehicle?.description ?? null,
        responsibleUserId: order.responsibleUserId,
        responsibleUserName:
          this.userNames.get(order.responsibleUserId) ?? null,
        responsibleUserEmail: null,
        branchId: order.branchId,
        branchName: this.branchNames.get(order.branchId) ?? null,
        supplierId: order.supplierId,
        supplierName: order.supplierId
          ? (this.supplierNames.get(order.supplierId) ?? null)
          : null,
        latitude: order.latitude ?? null,
        longitude: order.longitude ?? null,
        latitude_original: order.latitude_original ?? null,
        longitude_original: order.longitude_original ?? null,
        location_source: order.location_source ?? null,
        location_edited_by: order.location_edited_by ?? null,
        location_edited_at: order.location_edited_at ?? null,
        created_from: order.created_from,
        created_at: order.created_at,
        updated_at: order.updated_at,
      };
    }
  }

  async searchServiceOrderWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchServiceOrderWithCursorProps): Promise<CursorPaginatedServiceOrder> {
    const term = search?.trim().toLowerCase();

    // Newest first with the id as tiebreaker, like the real cursor.
    let filtered = this.serviceOrders
      .filter((order) => {
        if (order.businessId !== businessId) return false;
        if (!term) return true;

        const vehicle = this.vehicles.get(order.vehicleId);

        return [
          order.id,
          order.description ?? "",
          vehicle?.license_plate ?? "",
          vehicle?.description ?? "",
        ].some((text) => text.toLowerCase().includes(term));
      })
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.serviceOrders, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async searchServiceOrderByVehicleWithCursor({
    limit = 10,
    cursor,
    vehicleId,
    businessId,
  }: SearchServiceOrderByVehicleWithCursorProps): Promise<CursorPaginatedServiceOrder> {
    let filtered = this.serviceOrders
      .filter(
        (order) =>
          order.vehicleId === vehicleId && order.businessId === businessId,
      )
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.serviceOrders, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countServiceOrderForExport(
    query: ServiceOrderListQuery,
  ): Promise<number> {
    return this.serviceOrders.filter((order) => this.matches(order, query))
      .length;
  }
}

export { InMemoryServiceOrderRepository };
