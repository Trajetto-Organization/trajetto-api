import { v7 as uuidV7 } from "uuid";
import { IShipperRepository } from "../IShipper-repository";

import {
  Shipper,
  CreateShipperProps,
  UpdateShipperProps,
  ListShippersProps,
  ListShippersResult,
  SearchShipperWithCursorProps,
  CursorPaginatedShipper,
} from "../../dtos/shipper-dto";

class InMemoryShipperRepository implements IShipperRepository {
  public shippers: Shipper[] = [];
  public deliveryCounts = new Map<string, number>();

  async createShipper(shipperData: CreateShipperProps): Promise<Shipper> {
    const newShipper: Shipper = {
      id: uuidV7(),
      ...shipperData,
      cnpj: shipperData.cnpj || null,
      email: shipperData.email || null,
      telephone: shipperData.telephone || null,
      is_active: true,
    };

    this.shippers.push(newShipper);
    return newShipper;
  }

  async listShippers({
    page,
    pageSize,
    businessId,
    search,
  }: ListShippersProps): Promise<ListShippersResult> {
    let filtered = this.shippers.filter((s) => s.businessId === businessId);

    if (search) {
      const term = search.trim().toLowerCase();
      filtered = filtered.filter((s) =>
        [s.name, s.cnpj ?? "", s.email ?? ""].some((value) =>
          value.toLowerCase().includes(term),
        ),
      );
    }

    const skip = (page - 1) * pageSize;

    return {
      data: filtered.slice(skip, skip + pageSize),
      total: filtered.length,
    };
  }

  async searchShipperWithCursor({
    limit = 10,
    cursor,
    businessId,
  }: SearchShipperWithCursorProps): Promise<CursorPaginatedShipper> {
    let filtered = this.shippers.filter(
      (s) => s.businessId === businessId && s.is_active !== false,
    );

    if (cursor) {
      const cursorIndex = filtered.findIndex((s) => s.id === cursor);

      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countShippersSummary(
    businessId: string,
  ): Promise<{ total: number; active: number; withCnpj: number }> {
    const owned = this.shippers.filter((s) => s.businessId === businessId);

    return {
      total: owned.length,
      active: owned.filter((s) => s.is_active !== false).length,
      withCnpj: owned.filter((s) => !!s.cnpj).length,
    };
  }

  async findShipperById(shipperId: string): Promise<Shipper | null> {
    return this.shippers.find((s) => s.id === shipperId) ?? null;
  }

  async findShipperByName(
    businessId: string,
    name: string,
  ): Promise<Shipper | null> {
    return (
      this.shippers.find(
        (s) =>
          s.businessId === businessId &&
          s.name.toLowerCase() === name.toLowerCase(),
      ) ?? null
    );
  }

  async findShipperByCnpj(
    businessId: string,
    cnpj: string,
  ): Promise<Shipper | null> {
    return (
      this.shippers.find(
        (s) => s.businessId === businessId && s.cnpj === cnpj,
      ) ?? null
    );
  }

  async updateShipper(
    shipperId: string,
    shipperData: UpdateShipperProps,
  ): Promise<Shipper> {
    const index = this.shippers.findIndex((s) => s.id === shipperId);

    const filteredData = Object.fromEntries(
      Object.entries(shipperData).filter(([, value]) => value !== undefined),
    );

    this.shippers[index] = { ...this.shippers[index], ...filteredData };
    return this.shippers[index];
  }

  async deleteShipper(shipperId: string): Promise<Shipper> {
    const index = this.shippers.findIndex((s) => s.id === shipperId);
    return this.shippers.splice(index, 1)[0];
  }

  async countDeliveriesByShipperId(shipperId: string): Promise<number> {
    return this.deliveryCounts.get(shipperId) ?? 0;
  }
}

export { InMemoryShipperRepository };
