import { afterCursor, newestFirst } from "@/shared/in-memory/cursor";
import { v7 as uuidV7 } from "uuid";
import { Prisma } from "@prisma/client";
import { IPartRepository } from "../IPart-repository";

import {
  Part,
  CreatePartProps,
  ListPartProps,
  ListPartByBusinessIdProps,
  UpdatePart,
  SearchPartWithCursorProps,
  CursorPaginatedPart,
} from "../../dtos/part-dto";

import {
  PART_SORT_FALLBACK,
  partDescriptionKey,
  type PartSortKey,
} from "../../usecases/list-part/part-list";

interface ServiceOrderPartEntry {
  id: string;
  partId: string;
  serviceOrderId: string;
  quantity: number;
  unit_price: string;
}

/**
 * The twin of PartRepository: same tenant filter, search (substring, any
 * case), facet, order with the same tiebreaker, paging and counts. Supplier
 * names come from `supplierNames` (and their company from
 * `supplierBusiness`), since the twin has no supplier table.
 */
class InMemoryPartRepository implements IPartRepository {
  public parts: Part[] = [];
  public serviceOrderParts: ServiceOrderPartEntry[] = [];

  public supplierNames = new Map<string, string>();
  public supplierBusiness = new Map<string, string>();

  addServiceOrderPart(
    entry: Omit<ServiceOrderPartEntry, "id">,
  ): ServiceOrderPartEntry {
    const serviceOrderPart: ServiceOrderPartEntry = {
      id: uuidV7(),
      ...entry,
    };

    this.serviceOrderParts.push(serviceOrderPart);
    return serviceOrderPart;
  }

  async createPart(partData: CreatePartProps): Promise<Part> {
    const now = new Date();

    const newPart: Part = {
      id: uuidV7(),
      description: partData.description,
      unit_price: partData.unit_price.toString(),
      businessId: partData.businessId,
      supplierId: partData.supplierId || null,
      created_at: now,
      updated_at: now,
    };

    this.parts.push(newPart);
    return newPart;
  }

  private matches(
    part: Part,
    filters: Omit<ListPartByBusinessIdProps, "page" | "pageSize" | "sort" | "order">,
    exceptSupplier = false,
  ): boolean {
    if (part.businessId !== filters.businessId) return false;

    if (
      !exceptSupplier &&
      filters.supplierIds?.length &&
      !(part.supplierId && filters.supplierIds.includes(part.supplierId))
    ) {
      return false;
    }

    const term = filters.search?.trim().toLowerCase();

    if (!term) return true;

    return [
      part.id,
      part.description,
      part.supplierId ? (this.supplierNames.get(part.supplierId) ?? "") : "",
    ].some((text) => text.toLowerCase().includes(term));
  }

  private sortValue(part: Part, key: PartSortKey): string | number | null {
    switch (key) {
      case "created_at":
        return new Date(part.created_at).getTime();
      case "updated_at":
        return new Date(part.updated_at).getTime();
      case "description":
        return part.description;
      case "unit_price":
        return Number(part.unit_price);
      case "supplierName":
        return part.supplierId
          ? (this.supplierNames.get(part.supplierId) ?? null)
          : null;
    }
  }

  async listParts({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListPartByBusinessIdProps): Promise<ListPartProps> {
    const key = sort ?? PART_SORT_FALLBACK.sort;
    const direction =
      (order ?? (sort ? "asc" : PART_SORT_FALLBACK.order)) === "asc" ? 1 : -1;

    // NULLs sort as larger than any value, as in Postgres.
    const compare = (a: string | number | null, b: string | number | null) => {
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;

      return a < b ? -1 : 1;
    };

    const rows = this.parts
      .filter((part) => this.matches(part, filters))
      .sort(
        (a, b) =>
          direction * compare(this.sortValue(a, key), this.sortValue(b, key)) ||
          compare(
            new Date(b.created_at).getTime(),
            new Date(a.created_at).getTime(),
          ) ||
          compare(b.id, a.id),
      );

    const skip = (page - 1) * pageSize;

    const data = rows.slice(skip, skip + pageSize).map((part) => ({
      ...part,
      service_order_parts_count: this.serviceOrderParts.filter(
        (line) => line.partId === part.id,
      ).length,
    }));

    const groups = new Map<string | null, { count: number; priceSum: number }>();

    for (const part of this.parts.filter((entry) =>
      this.matches(entry, filters, true),
    )) {
      const keyOf = part.supplierId ?? null;
      const current = groups.get(keyOf) ?? { count: 0, priceSum: 0 };

      groups.set(keyOf, {
        count: current.count + 1,
        priceSum: current.priceSum + Number(part.unit_price),
      });
    }

    const labelOf = (id: string | null) =>
      id && this.supplierBusiness.get(id) === filters.businessId
        ? this.supplierNames.get(id)
        : undefined;

    const supplierCounts: ListPartProps["supplierCounts"] = Array.from(
      groups.entries(),
    ).map(([supplierId, group]) => ({
      supplierId,
      label: labelOf(supplierId),
      ...group,
    }));

    for (const id of filters.supplierIds ?? []) {
      if (labelOf(id) !== undefined && !groups.has(id)) {
        supplierCounts.push({ supplierId: id, label: labelOf(id), count: 0, priceSum: 0 });
      }
    }

    return { data, supplierCounts };
  }

  async updatePart({ partData, partId }: UpdatePart): Promise<Part> {
    const index = this.parts.findIndex((part) => part.id === partId);

    if (index === -1) {
      throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
        code: "P2025",
        clientVersion: "in-memory",
      });
    }

    // The real one keeps supplierId apart: null clears it, undefined keeps it.
    const { supplierId, ...fields } = partData;

    const filteredData = Object.fromEntries(
      Object.entries(fields).filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    if (filteredData.unit_price !== undefined) {
      filteredData.unit_price = String(filteredData.unit_price);
    }

    const updatedPart: Part = {
      ...this.parts[index],
      ...filteredData,
      ...(supplierId !== undefined ? { supplierId } : {}),
      updated_at: new Date(),
    };

    this.parts[index] = updatedPart;
    return updatedPart;
  }

  async deletePart(partId: string): Promise<Part> {
    const index = this.parts.findIndex((part) => part.id === partId);

    if (index === -1) {
      throw new Prisma.PrismaClientKnownRequestError("Record to delete does not exist.", {
        code: "P2025",
        clientVersion: "in-memory",
      });
    }

    // service_order_part.partId is ON DELETE RESTRICT: Postgres refuses a
    // part that lines still use, whatever the use case counted before.
    if (this.serviceOrderParts.some((line) => line.partId === partId)) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Foreign key constraint violated: `service_order_part_partId_fkey (index)`",
        { code: "P2003", clientVersion: "in-memory" },
      );
    }

    const deletedPart = this.parts.splice(index, 1)[0];
    return deletedPart;
  }

  async findPartById(partId: string): Promise<Part | null> {
    const part = this.parts.find((part) => part.id === partId);

    if (!part) return null;

    // The real one includes the supplier; the twin knows only its name.
    const supplierName = part.supplierId
      ? this.supplierNames.get(part.supplierId)
      : undefined;

    return {
      ...part,
      supplier: supplierName !== undefined ? { name: supplierName } : null,
    };
  }

  async findPartByDescription(
    description: string,
    businessId: string,
    exceptPartId?: string,
  ): Promise<Part | null> {
    // lower(btrim(...)) on both sides, like the real query.
    const key = partDescriptionKey(description);

    const part = this.parts.find(
      (part) =>
        part.businessId === businessId &&
        part.id !== exceptPartId &&
        partDescriptionKey(part.description) === key,
    );

    return part || null;
  }

  async countServiceOrderPartsByPartId(partId: string): Promise<number> {
    return this.serviceOrderParts.filter((sop) => sop.partId === partId).length;
  }

  async searchPartWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchPartWithCursorProps): Promise<CursorPaginatedPart> {
    const term = search?.trim().toLowerCase();

    let filtered = this.parts
      .filter(
        (part) =>
          part.businessId === businessId &&
          (!term ||
            [
              part.description,
              part.supplierId ? (this.supplierNames.get(part.supplierId) ?? "") : "",
            ].some((text) => text.toLowerCase().includes(term))),
      )
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );

    // Prisma's cursor: positioned on the cursor ROW, skip 1; an unknown
    // cursor yields nothing (it used to restart the list from the top).
    filtered = afterCursor(filtered, this.parts, cursor, newestFirst);

    const hasMore = filtered.length > limit;

    const data = filtered.slice(0, limit);
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }
}

export { InMemoryPartRepository };
