import { IShipperRepository } from "./IShipper-repository";
import {
  Shipper,
  CreateShipperProps,
  UpdateShipperProps,
  ListShippersProps,
  ListShippersResult,
  SearchShipperWithCursorProps,
  CursorPaginatedShipper,
} from "../dtos/shipper-dto";

import database from "@/../infra/database";

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
    businessId,
    search,
  }: ListShippersProps): Promise<ListShippersResult> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim() : "";

    const whereCondition = {
      businessId,
      ...(normalizedSearch && {
        OR: [
          { id: { contains: normalizedSearch, mode: "insensitive" as const } },
          { name: { contains: normalizedSearch, mode: "insensitive" as const } },
          { cnpj: { contains: normalizedSearch, mode: "insensitive" as const } },
          {
            email: { contains: normalizedSearch, mode: "insensitive" as const },
          },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.shipper.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        orderBy: { created_at: "desc" },
      }),
      this.prisma.shipper.count({ where: whereCondition }),
    ]);

    return { data, total };
  }

  // Feeds the infinite-scroll combobox: only active shippers, because the
  // select exists to start a new delivery.
  async searchShipperWithCursor({
    limit = 10,
    cursor,
    businessId,
  }: SearchShipperWithCursorProps): Promise<CursorPaginatedShipper> {
    const shippers = await this.prisma.shipper.findMany({
      where: { businessId, is_active: true },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      orderBy: { name: "asc" },
    });

    const hasMore = shippers.length > limit;

    const data = hasMore ? shippers.slice(0, limit) : shippers;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countShippersSummary(
    businessId: string,
  ): Promise<{ total: number; active: number; withCnpj: number }> {
    const [total, active, withCnpj] = await Promise.all([
      this.prisma.shipper.count({ where: { businessId } }),
      this.prisma.shipper.count({ where: { businessId, is_active: true } }),
      this.prisma.shipper.count({
        where: { businessId, NOT: { cnpj: null } },
      }),
    ]);

    return { total, active, withCnpj };
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
        name: { equals: name, mode: "insensitive" },
      },
    });
  }

  async findShipperByCnpj(
    businessId: string,
    cnpj: string,
  ): Promise<Shipper | null> {
    return this.prisma.shipper.findFirst({
      where: { businessId, cnpj },
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
