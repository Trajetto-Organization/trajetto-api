import { afterCursor, byNameThenId } from "@/shared/in-memory/cursor";
import { v7 as uuidV7 } from "uuid";
import {
  SHIPPER_COLUMN_DEFAULTS,
  withColumnDefaults,
} from "@/shared/in-memory/column-defaults";
import { IShipperRepository } from "../IShipper-repository";

import { requireIndex, uniqueViolation } from "@/shared/in-memory/prisma-errors";

import { compareForOrder } from "@/shared/pagination/in-memory-order";
import { isActiveFilter } from "@/shared/delivery/catalog-list";
import {
  SHIPPER_SORT_FALLBACK,
  cnpjSearchDigits,
  type ShipperGroup,
} from "../../usecases/list-shipper/shipper-list";

import {
  Shipper,
  CreateShipperProps,
  UpdateShipperProps,
  ListShippersProps,
  ListShippersPage,
  SearchShipperWithCursorProps,
  CursorPaginatedShipper,
} from "../../dtos/shipper-dto";

/**
 * The shipper table, mirrored: the (businessId, name) and (businessId, cnpj)
 * unique indexes answer P2002 like Postgres, the listing sorts, filters and
 * groups like SHIPPER_SORT/shipperListWhere (search on id, name, CNPJ — masked
 * or not — and e-mail; ties by created_at desc, id desc), and the picker orders by name
 * and searches name, CNPJ and e-mail. A twin that accepted the duplicate or
 * ignored the term would let a test prove what the database refuses.
 */
class InMemoryShipperRepository implements IShipperRepository {
  public shippers: Shipper[] = [];
  public deliveryCounts = new Map<string, number>();

  private assertUnique(candidate: Shipper, ignoreId?: string) {
    const others = this.shippers.filter(
      (s) => s.businessId === candidate.businessId && s.id !== ignoreId,
    );

    if (others.some((s) => s.name === candidate.name)) {
      throw uniqueViolation(["businessId", "name"]);
    }

    if (candidate.cnpj && others.some((s) => s.cnpj === candidate.cnpj)) {
      throw uniqueViolation(["businessId", "cnpj"]);
    }
  }

  async createShipper(shipperData: CreateShipperProps): Promise<Shipper> {
    const now = new Date();

    // withColumnDefaults: a key the caller left undefined keeps the column
    // default instead of erasing it, as Prisma omits it from the INSERT.
    const newShipper: Shipper = {
      ...withColumnDefaults(SHIPPER_COLUMN_DEFAULTS, shipperData),
      id: uuidV7(),
      cnpj: shipperData.cnpj || null,
      email: shipperData.email || null,
      telephone: shipperData.telephone || null,
      is_active: true,
      created_at: now,
      updated_at: now,
    };

    this.assertUnique(newShipper);

    this.shippers.push(newShipper);
    return newShipper;
  }

  async listShippers({
    page,
    pageSize,
    businessId,
    search,
    sort,
    order,
    statuses,
  }: ListShippersProps): Promise<ListShippersPage> {
    const term = search?.trim().toLowerCase();
    const digits = term ? cnpjSearchDigits(term) : undefined;

    // The base: tenant and search, no facet (what the counts group over).
    const base = this.shippers.filter(
      (s) =>
        s.businessId === businessId &&
        (!term ||
          [s.id ?? "", s.name, s.cnpj ?? "", s.email ?? ""].some((value) =>
            value.toLowerCase().includes(term),
          ) ||
          (!!digits && digits !== term && (s.cnpj ?? "").includes(digits))),
    );

    const isActive = isActiveFilter(statuses);

    const key = sort ?? SHIPPER_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : SHIPPER_SORT_FALLBACK.order);

    const time = (value: Date | string | undefined) =>
      value === undefined ? undefined : new Date(value);

    const rows = base
      .filter((s) => isActive === undefined || (s.is_active !== false) === isActive)
      .sort(
        (a, b) =>
          (key === "name"
            ? compareForOrder(a.name, b.name, direction)
            : compareForOrder(time(a[key]), time(b[key]), direction)) ||
          compareForOrder(time(a.created_at), time(b.created_at), "desc") ||
          compareForOrder(a.id, b.id, "desc"),
      );

    const groups = new Map<boolean, ShipperGroup>();

    for (const s of base) {
      const active = s.is_active !== false;
      const group = groups.get(active) ?? { is_active: active, count: 0, withCnpj: 0 };

      group.count += 1;
      if (s.cnpj) group.withCnpj += 1;

      groups.set(active, group);
    }

    const skip = (page - 1) * pageSize;

    return {
      data: rows.slice(skip, skip + pageSize),
      groups: Array.from(groups.values()),
    };
  }

  async searchShipperWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchShipperWithCursorProps): Promise<CursorPaginatedShipper> {
    const term = search?.trim().toLowerCase();
    // The CNPJ column holds digits: a masked CNPJ is matched by its digits,
    // a name ("Loja 2") as typed.
    const cnpjTerm = term ? (cnpjSearchDigits(term) ?? term) : "";

    let filtered = this.shippers
      .filter(
        (s) =>
          s.businessId === businessId &&
          s.is_active !== false &&
          (!term ||
            [s.name, s.email ?? ""].some((value) =>
              value.toLowerCase().includes(term),
            ) ||
            (s.cnpj ?? "").includes(cnpjTerm)),
      )
      .sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : (a.id ?? "") < (b.id ?? "") ? -1 : 1,
      );

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.shippers, cursor, byNameThenId);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
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
    // P2025 like Prisma; index -1 used to write `array[-1]`.
    const index = requireIndex(this.shippers, (s) => s.id === shipperId);

    const filteredData = Object.fromEntries(
      Object.entries(shipperData).filter(([, value]) => value !== undefined),
    );

    const next = {
      ...this.shippers[index],
      ...filteredData,
      updated_at: new Date(),
    } as Shipper;

    this.assertUnique(next, shipperId);

    this.shippers[index] = next;
    return this.shippers[index];
  }

  async deleteShipper(shipperId: string): Promise<Shipper> {
    // P2025 like Prisma; `splice(-1, 1)` used to delete the last shipper.
    const index = requireIndex(this.shippers, (s) => s.id === shipperId, "delete");
    return this.shippers.splice(index, 1)[0];
  }

  async countDeliveriesByShipperId(shipperId: string): Promise<number> {
    return this.deliveryCounts.get(shipperId) ?? 0;
  }
}

export { InMemoryShipperRepository };
