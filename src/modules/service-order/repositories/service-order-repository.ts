import { IServiceOrderRepository } from "./IService-order-repository";
import {
  ServiceOrder,
  CreateServiceOrderProps,
  ListServiceOrderProps,
  ListServiceOrderByBusinessIdProps,
  UpdateServiceOrder,
  SearchServiceOrderWithCursorProps,
  CursorPaginatedServiceOrder,
  SearchServiceOrderByVehicleWithCursorProps,
  ServiceOrderListQuery,
  DeleteServiceOrderResult,
} from "../dtos/service-order-dto";

import database from "@/../infra/database";
import { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  SERVICE_ORDER_SORT,
  SERVICE_ORDER_STATUSES,
  partsTotalOf,
  serviceOrderListWhere,
  statusCondition,
} from "../usecases/list-service-order/service-order-list";
import {
  EXPORT_ORDER,
  exportBatchWhere,
  type ExportKey,
} from "@/shared/pagination/export-keyset";

class ServiceOrderRepository implements IServiceOrderRepository {
  constructor(private prisma = database) {}

  // `tx` lets the use case create the order and its outbox event atomically.
  async createServiceOrder(
    serviceOrderData: CreateServiceOrderProps,
    tx?: Prisma.TransactionClient,
  ): Promise<ServiceOrder> {
    const client = tx ?? this.prisma;

    const serviceOrderCreated = await client.serviceOrder.create({
      data: {
        date: serviceOrderData.date || new Date(),
        completion_date: serviceOrderData.completion_date,
        maintenance_type: serviceOrderData.maintenance_type,
        total_amount: serviceOrderData.total_amount,
        description: serviceOrderData.description,
        current_mileage_at_service: serviceOrderData.current_mileage_at_service,
        maintenance_interval_km_at_service:
          serviceOrderData.maintenance_interval_km_at_service,
        last_maintenance_mileage_at_service:
          serviceOrderData.last_maintenance_mileage_at_service,
        new_mileage_after_service: serviceOrderData.new_mileage_after_service,
        latitude: serviceOrderData.latitude,
        longitude: serviceOrderData.longitude,
        // Where the record came from and the GPS before any manual edit: the
        // use case decides them (MOBILE_APP + GPS_AUTO, GPS_MANUAL with the
        // original point, USER_MANUAL...), and this create used to drop all
        // four, so every order read WEB_DASHBOARD with no original point.
        latitude_original: serviceOrderData.latitude_original ?? null,
        longitude_original: serviceOrderData.longitude_original ?? null,
        location_source: serviceOrderData.location_source ?? null,
        created_from: serviceOrderData.created_from,
        client_submission_id: serviceOrderData.client_submission_id ?? null,
        business: {
          connect: {
            id: serviceOrderData.businessId,
          },
        },
        vehicle: {
          connect: {
            id: serviceOrderData.vehicleId,
          },
        },
        responsibleUser: {
          connect: {
            id: serviceOrderData.responsibleUserId,
          },
        },
        branch: {
          connect: {
            id: serviceOrderData.branchId,
          },
        },
        ...(serviceOrderData.supplierId && {
          supplier: {
            connect: {
              id: serviceOrderData.supplierId,
            },
          },
        }),
      },
    });

    return serviceOrderCreated;
  }

  async findServiceOrderBySubmissionId(
    businessId: string,
    clientSubmissionId: string,
  ): Promise<ServiceOrder | null> {
    // The unique (businessId, client_submission_id) index answers this.
    return this.prisma.serviceOrder.findUnique({
      where: {
        businessId_client_submission_id: {
          businessId,
          client_submission_id: clientSubmissionId,
        },
      },
    });
  }

  async listServiceOrders({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListServiceOrderByBusinessIdProps): Promise<ListServiceOrderProps> {
    // Two connections at most (tests/E2E/connection-fan-out): the page, and
    // the counts one after another.
    const [rows, counts] = await Promise.all([
      this.prisma.serviceOrder.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: serviceOrderListWhere(filters),
        orderBy: resolveOrderBy(SERVICE_ORDER_SORT, { sort, order }),
        include: {
          business: { select: { corporate_reason: true } },
          vehicle: { select: { license_plate: true, description: true } },
          responsibleUser: { select: { name: true, email: true } },
          branch: { select: { corporate_reason: true, fantasy_name: true } },
          supplier: { select: { name: true } },
          parts: { include: { part: true } },
          _count: { select: { accountsPayable: true } },
        },
      }),
      this.countListFacets(filters),
    ]);

    return {
      data: rows.map(({ _count, ...row }) => ({
        ...row,
        parts_total: partsTotalOf(row.parts),
        parts_count: row.parts.length,
        accounts_payable_count: _count.accountsPayable,
      })),
      ...counts,
    };
  }

  /** The status x type cells and the branch options, one after another. */
  private async countListFacets(
    filters: ServiceOrderListQuery,
  ): Promise<Pick<ListServiceOrderProps, "cells" | "branchCounts">> {
    const base = serviceOrderListWhere(filters, {
      except: ["status", "maintenanceType"],
    });

    const cells: ListServiceOrderProps["cells"] = [];

    for (const status of SERVICE_ORDER_STATUSES) {
      const grouped = await this.prisma.serviceOrder.groupBy({
        by: ["maintenance_type"],
        where: { AND: [base, statusCondition([status]) ?? {}] },
        _count: { _all: true },
        _sum: { total_amount: true },
      });

      for (const group of grouped) {
        cells.push({
          status,
          maintenance_type: group.maintenance_type,
          count: group._count._all,
          totalAmount: Number(group._sum.total_amount ?? 0),
        });
      }
    }

    const byBranch = await this.prisma.serviceOrder.groupBy({
      by: ["branchId"],
      where: serviceOrderListWhere(filters, { except: ["branch"] }),
      _count: { _all: true },
    });

    const branchIds = Array.from(
      new Set([
        ...byBranch.map((group) => group.branchId),
        ...(filters.branchIds ?? []),
      ]),
    );

    // Names only from this company: an id of another tenant in the URL
    // brings neither a row nor a name.
    const branches = branchIds.length
      ? await this.prisma.branch.findMany({
          where: { id: { in: branchIds }, businessId: filters.businessId },
          select: { id: true, corporate_reason: true },
        })
      : [];

    const countOf = new Map(
      byBranch.map((group) => [group.branchId, group._count._all]),
    );

    const branchCounts = branches
      .map((branch) => ({
        value: branch.id,
        label: branch.corporate_reason,
        count: countOf.get(branch.id) ?? 0,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));

    return { cells, branchCounts };
  }

  async updateServiceOrder(
    { serviceOrderData, serviceOrderId }: UpdateServiceOrder,
    tx?: Prisma.TransactionClient,
  ): Promise<ServiceOrder> {
    const client = tx ?? this.prisma;

    const filteredData = Object.fromEntries(
      Object.entries(serviceOrderData).filter(
        ([_, value]) => value !== undefined,
      ),
    );

    const updateServiceOrder = await client.serviceOrder.update({
      where: {
        id: serviceOrderId,
      },
      data: filteredData,
      include: {
        vehicle: true,
        responsibleUser: true,
        branch: true,
        supplier: true,
      },
    });

    return updateServiceOrder;
  }

  async deleteServiceOrderGuarded(
    serviceOrderId: string,
    businessId: string,
  ): Promise<DeleteServiceOrderResult> {
    return this.prisma.$transaction(async (tx) => {
      // FOR UPDATE on the order: a bill inserted in between either commits
      // first (and is counted below) or waits on this lock and then fails its
      // foreign key. Counting without the lock let a paid bill lose its
      // origin to SET NULL between the check and the delete.
      const [locked] = await tx.$queryRaw<
        Array<{ completion_date: Date | null }>
      >`SELECT "completion_date" FROM "service_order"
         WHERE "id" = ${serviceOrderId} AND "businessId" = ${businessId}
         FOR UPDATE`;

      if (!locked) return { missing: true as const };

      const accountsPayable = await tx.accountPayable.count({
        where: { serviceOrderId },
      });

      const completed = locked.completion_date !== null;

      if (completed || accountsPayable > 0) {
        return { blocked: { completed, accountsPayable } };
      }

      const partsRemoved = await tx.serviceOrderPart.count({
        where: { serviceOrderId },
      });

      const deleted = await tx.serviceOrder.delete({
        where: { id: serviceOrderId },
      });

      return { deleted, partsRemoved };
    });
  }

  async findServiceOrderById(
    serviceOrderId: string,
  ): Promise<ServiceOrder | null> {
    const findServiceOrderById = await this.prisma.serviceOrder.findUnique({
      where: {
        id: serviceOrderId,
      },
      include: {
        vehicle: true,
        responsibleUser: true,
        branch: true,
        supplier: true,
        parts: {
          include: {
            part: true,
          },
        },
      },
    });

    return findServiceOrderById;
  }

  async findServiceOrdersByVehicleId(
    vehicleId: string,
  ): Promise<ServiceOrder[] | null> {
    const findServiceOrdersByVehicleId =
      await this.prisma.serviceOrder.findMany({
        where: {
          vehicleId: vehicleId,
        },
      });

    return findServiceOrdersByVehicleId;
  }

  async findServiceOrdersByResponsibleUserId(
    responsibleUserId: string,
  ): Promise<ServiceOrder[]> {
    const serviceOrders = await this.prisma.serviceOrder.findMany({
      where: { responsibleUserId },
      include: {
        vehicle: { select: { license_plate: true, description: true } },
        business: { select: { corporate_reason: true } },
      },
      orderBy: {
        created_at: "desc", // Sort by created_at
      },
    });

    return serviceOrders;
  }

  async searchServiceOrderWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchServiceOrderWithCursorProps): Promise<CursorPaginatedServiceOrder> {
    const term = search?.trim();

    const items = await this.prisma.serviceOrder.findMany({
      where: {
        businessId,
        // What the picker shows of each order: its vehicle and description.
        ...(term &&
          buildSearchOr<Prisma.ServiceOrderWhereInput>([
            { id: { contains: term, mode: "insensitive" } },
            { description: { contains: term, mode: "insensitive" } },
            {
              vehicle: {
                OR: [
                  { license_plate: { contains: term, mode: "insensitive" } },
                  { description: { contains: term, mode: "insensitive" } },
                ],
              },
            },
          ])),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      // The id breaks created_at ties, so a page boundary never repeats a row.
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      include: {
        vehicle: {
          select: {
            license_plate: true,
            description: true,
          },
        },
      },
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async searchServiceOrderByVehicleWithCursor({
    limit = 10,
    cursor,
    vehicleId,
    businessId,
  }: SearchServiceOrderByVehicleWithCursorProps): Promise<CursorPaginatedServiceOrder> {
    const items = await this.prisma.serviceOrder.findMany({
      where: { vehicleId, businessId },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      include: {
        vehicle: {
          select: {
            id: true,
            license_plate: true,
            description: true,
            brand: true,
            model: true,
          },
        },
        responsibleUser: {
          select: {
            id: true,
            name: true,
          },
        },
        branch: {
          select: {
            id: true,
            corporate_reason: true,
          },
        },
        supplier: {
          select: {
            id: true,
            name: true,
          },
        },
        parts: {
          select: {
            id: true,
            quantity: true,
            unit_price: true,
            part: {
              select: {
                description: true,
              },
            },
          },
        },
      },
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async *streamServiceOrdersForExport(
    query: ServiceOrderListQuery,
  ): AsyncGenerator<any> {
    // The listing's where: the file holds what the screen shows (5.8).
    const whereCondition = serviceOrderListWhere(query);

    const batchSize = 1000;
    let after: ExportKey | null = null;

    // Keyset batches in creation order (export-keyset.ts).
    while (true) {
      const serviceOrders: any = await this.prisma.serviceOrder.findMany({
        where: exportBatchWhere(whereCondition, after),
        include: {
          business: { select: { corporate_reason: true } },
          vehicle: { select: { license_plate: true, description: true } },
          responsibleUser: { select: { name: true, email: true } },
          branch: { select: { corporate_reason: true } },
          supplier: { select: { name: true } },
          parts: {
            select: {
              unit_price: true,
              quantity: true,
              discount_percentage: true,
            },
          },
        },
        orderBy: [...EXPORT_ORDER],
        take: batchSize,
      });

      if (serviceOrders.length === 0) break;
      for (const so of serviceOrders) {
        yield {
          id: so.id,
          date: so.date,
          completion_date: so.completion_date,
          maintenance_type: so.maintenance_type,
          total_amount: so.total_amount?.toNumber(),
          parts_total: partsTotalOf(so.parts),
          description: so.description,
          current_mileage_at_service: so.current_mileage_at_service,
          maintenance_interval_km_at_service:
            so.maintenance_interval_km_at_service,
          last_maintenance_mileage_at_service:
            so.last_maintenance_mileage_at_service,
          new_mileage_after_service: so.new_mileage_after_service,
          businessId: so.businessId,
          businessName: so.business.corporate_reason,
          vehicleId: so.vehicleId,
          vehicleLicensePlate: so.vehicle.license_plate,
          vehicleDescription: so.vehicle.description,
          responsibleUserId: so.responsibleUserId,
          responsibleUserName: so.responsibleUser.name,
          responsibleUserEmail: so.responsibleUser.email,
          branchId: so.branchId,
          branchName: so.branch.corporate_reason,
          supplierId: so.supplierId,
          supplierName: so.supplier?.name || null,
          // Proper null handling to avoid Number(null) = 0.
          latitude: so.latitude,
          longitude: so.longitude,
          latitude_original: so.latitude_original,
          longitude_original: so.longitude_original,
          location_source: so.location_source,
          location_edited_by: so.location_edited_by,
          location_edited_at: so.location_edited_at,
          created_from: so.created_from,
          created_at: so.created_at,
          updated_at: so.updated_at,
        };
      }

      if (serviceOrders.length < batchSize) break;

      const last: ExportKey = serviceOrders[serviceOrders.length - 1];
      after = { created_at: last.created_at, id: last.id };
    }
  }

  async countServiceOrderForExport(
    query: ServiceOrderListQuery,
  ): Promise<number> {
    return this.prisma.serviceOrder.count({
      where: serviceOrderListWhere(query),
    });
  }
}

export { ServiceOrderRepository };
