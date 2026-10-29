import { IShipperRepository } from "./IShipper-repository";
import {
  Shipper,
  CreateShipperProps,
  UpdateShipperProps,
  ListShippersProps,
  ListShippersPage,
  SearchShipperWithCursorProps,
  CursorPaginatedShipper,
} from "../dtos/shipper-dto";

import database from "@/../infra/database";
import { buildSearchOr } from "@/shared/pagination/search-or";
import { insensitiveEquals } from "@/shared/utils/like-pattern";
import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  SHIPPER_SORT,
  cnpjSearchDigits,
  shipperListWhere,
} from "../usecases/list-shipper/shipper-list";

class ShipperRepository implements IShipperRepository {
  constructor(private prisma = database) {}

  async createShipper(shipperData: CreateShipperProps): Promise<Shipper> {
    const shipperCreated = await this.prisma.shipper.create({
      data: {
        ...shipperData,
        cnpj: shipperData.cnpj || null,
        email: shipperData.email || null,
        telephone: shipperData.telephone || null,
      },
    });

    return shipperCreated;
  }

  async listShippers({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListShippersProps): Promise<ListShippersPage> {
    // Two queries in parallel, the screen's connection budget: the page, and
    // one GROUP BY that yields the pager total, the cards and the filter.
    const [data, grouped] = await Promise.all([
      this.prisma.shipper.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: shipperListWhere(filters, { withFacets: true }),
        orderBy: resolveOrderBy(SHIPPER_SORT, { sort, order }),
      }),
      this.prisma.shipper.groupBy({
        by: ["is_active"],
        where: shipperListWhere(filters, { withFacets: false }),
        // _count of a column counts its non-NULL values: the CNPJ card.
        _count: { _all: true, cnpj: true },
      }),
    ]);

    return {
      data,
      groups: grouped.map((group) => ({
        is_active: group.is_active,
        count: group._count._all,
        withCnpj: group._count.cnpj,
      })),
    };
  }

  // Feeds the infinite-scroll combobox: only active shippers, because the
  // select exists to start a new delivery.
  async searchShipperWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchShipperWithCursorProps): Promise<CursorPaginatedShipper> {
    const term = search?.trim() ?? "";

    // The typed term is searched HERE, not in the loaded page: with more
    // than one page of shippers, the one typed may not be loaded yet.
    const shippers = await this.prisma.shipper.findMany({
      where: {
        businessId,
        is_active: true,
        ...(term &&
          buildSearchOr([
            { name: { contains: term, mode: "insensitive" as const } },
            // The column holds digits: a masked CNPJ is matched by its
            // digits, a name ("Loja 2") as typed.
            { cnpj: { contains: cnpjSearchDigits(term) ?? term } },
            { email: { contains: term, mode: "insensitive" as const } },
          ])),
      },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      // The name is unique per company; the id only makes the order total.
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });

    const hasMore = shippers.length > limit;

    const data = hasMore ? shippers.slice(0, limit) : shippers;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async findShipperById(shipperId: string): Promise<Shipper | null> {
    return this.prisma.shipper.findUnique({ where: { id: shipperId } });
  }

  async findShipperByName(
    businessId: string,
    name: string,
  ): Promise<Shipper | null> {
    return this.prisma.shipper.findFirst({
      where: {
        businessId,
        // Escaped: the value is an ILIKE pattern underneath (like-pattern.ts).
        name: insensitiveEquals(name),
      },
    });
  }

  async findShipperByCnpj(
    businessId: string,
    cnpj: string,
  ): Promise<Shipper | null> {
    // Unique per company since decision 5.7 (shipper_businessId_cnpj_key).
    return this.prisma.shipper.findUnique({
      where: { businessId_cnpj: { businessId, cnpj } },
    });
  }

  async updateShipper(
    shipperId: string,
    shipperData: UpdateShipperProps,
  ): Promise<Shipper> {
    const filteredData = Object.fromEntries(
      Object.entries(shipperData).filter(([, value]) => value !== undefined),
    );

    return this.prisma.shipper.update({
      where: { id: shipperId },
      data: filteredData,
    });
  }

  async deleteShipper(shipperId: string): Promise<Shipper> {
    return this.prisma.shipper.delete({ where: { id: shipperId } });
  }

  async countDeliveriesByShipperId(shipperId: string): Promise<number> {
    return this.prisma.delivery.count({ where: { shipperId } });
  }
}

export { ShipperRepository };
