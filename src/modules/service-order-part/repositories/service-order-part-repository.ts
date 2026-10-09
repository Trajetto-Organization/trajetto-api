import { IServiceOrderPartRepository } from "./IService-order-part-repository";
import {
  ServiceOrderPart,
  CreateServiceOrderPartProps,
  ListServiceOrderPartProps,
  ListServiceOrderPartByBusinessIdProps,
  UpdateServiceOrderPart,
  ServiceOrderTotals,
} from "../dtos/service-order-part-dto";

import database from "@/../infra/database";

import { resolveOrderBy } from "@/shared/pagination/list-query";
import { partsTotalOf } from "@/modules/service-order/usecases/list-service-order/service-order-list";

import {
  SERVICE_ORDER_PART_SORT,
  serviceOrderPartListSql,
  serviceOrderPartListWhere,
} from "../usecases/list-service-order-part/service-order-part-list";

class ServiceOrderPartRepository implements IServiceOrderPartRepository {
  constructor(private prisma = database) {}

  async createServiceOrderPart(
    serviceOrderPartData: CreateServiceOrderPartProps,
  ): Promise<ServiceOrderPart> {
    const serviceOrderPartCreated = await this.prisma.serviceOrderPart.create({
      data: {
        unit_price: serviceOrderPartData.unit_price,
        quantity: serviceOrderPartData.quantity,
        discount_percentage: serviceOrderPartData.discount_percentage,
        business: {
          connect: {
            id: serviceOrderPartData.businessId,
          },
        },
        serviceOrder: {
          connect: {
            id: serviceOrderPartData.serviceOrderId,
          },
        },
        part: {
          connect: {
            id: serviceOrderPartData.partId,
          },
        },
      },
      include: {
        part: true,
      },
    });

    return serviceOrderPartCreated;
  }

  async listServiceOrderParts({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListServiceOrderPartByBusinessIdProps): Promise<ListServiceOrderPartProps> {
    // Two connections at most: the page, and the counts after one another.
    const [data, counts] = await Promise.all([
      this.prisma.serviceOrderPart.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: serviceOrderPartListWhere(filters),
        orderBy: resolveOrderBy(SERVICE_ORDER_PART_SORT, { sort, order }),
        include: {
          part: true,
          business: { select: { corporate_reason: true } },
          serviceOrder: {
            select: {
              id: true,
              date: true,
              total_amount: true,
              completion_date: true,
              vehicle: { select: { license_plate: true, description: true } },
            },
          },
        },
      }),
      this.countList(filters),
    ]);

    return { data, ...counts };
  }

  private async countList(
    filters: Omit<ListServiceOrderPartByBusinessIdProps, "page" | "pageSize" | "sort" | "order">,
  ): Promise<Pick<ListServiceOrderPartProps, "aggregate" | "partCounts">> {
    // The value needs price × quantity × (1 − discount) per line, which
    // Prisma's aggregate cannot express; the WHERE mirrors the listing's.
    const [row] = await this.prisma.$queryRaw<
      Array<{ count: number; with_discount: number; total_value: number }>
    >`SELECT count(*)::int AS count,
             count(*) FILTER (WHERE COALESCE(sop."discount_percentage", 0) > 0)::int AS with_discount,
             COALESCE(SUM(sop."unit_price" * sop."quantity"
               * (1 - COALESCE(sop."discount_percentage", 0) / 100)), 0)::float8 AS total_value
        FROM "service_order_part" sop
        JOIN "part" p ON p."id" = sop."partId"
        JOIN "service_order" so ON so."id" = sop."serviceOrderId"
        JOIN "vehicle" v ON v."id" = so."vehicleId"
       WHERE ${serviceOrderPartListSql(filters)}`;

    const grouped = await this.prisma.serviceOrderPart.groupBy({
      by: ["partId"],
      where: serviceOrderPartListWhere(filters, { except: "part" }),
      _count: { _all: true },
    });

    const ids = Array.from(
      new Set([...grouped.map((group) => group.partId), ...(filters.partIds ?? [])]),
    );

    // Names only from this company's catalog.
    const parts = ids.length
      ? await this.prisma.part.findMany({
          where: { id: { in: ids }, businessId: filters.businessId },
          select: { id: true, description: true },
        })
      : [];

    const countOf = new Map(grouped.map((group) => [group.partId, group._count._all]));

    return {
      aggregate: {
        count: row?.count ?? 0,
        withDiscount: row?.with_discount ?? 0,
        totalValue: Number(row?.total_value ?? 0),
      },
      partCounts: parts.map((part) => ({
        value: part.id,
        label: part.description,
        count: countOf.get(part.id) ?? 0,
      })),
    };
  }

  async updateServiceOrderPart({
    serviceOrderPartData,
    serviceOrderPartId,
  }: UpdateServiceOrderPart): Promise<ServiceOrderPart> {
    const filteredData = Object.fromEntries(
      Object.entries(serviceOrderPartData).filter(
        ([_, value]) => value !== undefined,
      ),
    );

    const updateServiceOrderPart = await this.prisma.serviceOrderPart.update({
      where: {
        id: serviceOrderPartId,
      },
      data: filteredData,
      include: {
        part: true,
      },
    });

    return updateServiceOrderPart;
  }

  async deleteServiceOrderPart(
    serviceOrderPartId: string,
  ): Promise<ServiceOrderPart> {
    const deleteServiceOrderPart = await this.prisma.serviceOrderPart.delete({
      where: {
        id: serviceOrderPartId,
      },
    });

    return deleteServiceOrderPart;
  }

  async findServiceOrderPartById(
    serviceOrderPartId: string,
  ): Promise<ServiceOrderPart | null> {
    const findServiceOrderPartById =
      await this.prisma.serviceOrderPart.findUnique({
        where: {
          id: serviceOrderPartId,
        },
        include: {
          part: true,
          serviceOrder: true,
        },
      });

    return findServiceOrderPartById;
  }

  async findServiceOrderPartByPartId(
    partId: string,
    serviceOrderId: string,
  ): Promise<ServiceOrderPart | null> {
    const findServiceOrderPartByPartId =
      await this.prisma.serviceOrderPart.findFirst({
        where: {
          partId: partId,
          serviceOrderId: serviceOrderId,
        },
      });

    return findServiceOrderPartByPartId;
  }

  async serviceOrderTotals(
    serviceOrderId: string,
  ): Promise<ServiceOrderTotals | null> {
    const order = await this.prisma.serviceOrder.findUnique({
      where: { id: serviceOrderId },
      select: {
        total_amount: true,
        parts: {
          select: { unit_price: true, quantity: true, discount_percentage: true },
        },
      },
    });

    if (!order) return null;

    return {
      totalAmount: Number(order.total_amount),
      partsTotal: partsTotalOf(order.parts),
    };
  }

  async calculateServiceOrderTotal(serviceOrderId: string): Promise<number> {
    // Search for all parts of the work order
    const serviceOrderParts = await this.prisma.serviceOrderPart.findMany({
      where: {
        serviceOrderId: serviceOrderId,
      },
    });

    // Calculate the total
    let total = 0;

    for (const part of serviceOrderParts) {
      const partTotal = Number(part.unit_price) * part.quantity;
      const discount = partTotal * (Number(part.discount_percentage) / 100);

      total += partTotal - discount;
    }

    return total;
  }
}

export { ServiceOrderPartRepository };
