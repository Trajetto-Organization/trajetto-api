import { IPartRepository } from "./IPart-repository";
import {
  Part,
  CreatePartProps,
  ListPartByBusinessIdProps,
  ListPartProps,
  UpdatePart,
  SearchPartWithCursorProps,
  CursorPaginatedPart,
} from "../dtos/part-dto";

import database from "@/../infra/database";
import { Prisma } from "@prisma/client";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { resolveOrderBy } from "@/shared/pagination/list-query";

import { PART_SORT, partListWhere } from "../usecases/list-part/part-list";

class PartRepository implements IPartRepository {
  constructor(private prisma = database) {}

  async createPart(partData: CreatePartProps): Promise<Part> {
    const partCreated = await this.prisma.part.create({
      data: {
        description: partData.description,
        unit_price: partData.unit_price,
        business: {
          connect: {
            id: partData.businessId,
          },
        },
        ...(partData.supplierId && {
          supplier: {
            connect: {
              id: partData.supplierId,
            },
          },
        }),
      },
    });

    return partCreated;
  }

  async listParts({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListPartByBusinessIdProps): Promise<ListPartProps> {
    // Two connections at most: the page, and the counts after one another.
    const [rows, supplierCounts] = await Promise.all([
      this.prisma.part.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: partListWhere(filters),
        orderBy: resolveOrderBy(PART_SORT, { sort, order }),
        include: {
          supplier: { select: { name: true } },
          business: { select: { corporate_reason: true } },
          _count: { select: { serviceOrderParts: true } },
        },
      }),
      this.countBySupplier(filters),
    ]);

    return {
      data: rows.map(({ _count, ...row }) => ({
        ...row,
        service_order_parts_count: _count.serviceOrderParts,
      })),
      supplierCounts,
    };
  }

  private async countBySupplier(
    filters: Omit<ListPartByBusinessIdProps, "page" | "pageSize" | "sort" | "order">,
  ): Promise<ListPartProps["supplierCounts"]> {
    const grouped = await this.prisma.part.groupBy({
      by: ["supplierId"],
      where: partListWhere(filters, { except: "supplier" }),
      _count: { _all: true },
      _sum: { unit_price: true },
    });

    const ids = Array.from(
      new Set([
        ...grouped.flatMap((group) => (group.supplierId ? [group.supplierId] : [])),
        ...(filters.supplierIds ?? []),
      ]),
    );

    // Names only from this company: another tenant's id in the URL brings
    // neither a row nor a name.
    const suppliers = ids.length
      ? await this.prisma.supplier.findMany({
          where: { id: { in: ids }, businessId: filters.businessId },
          select: { id: true, name: true },
        })
      : [];

    const nameOf = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));

    const counts: ListPartProps["supplierCounts"] = grouped.map((group) => ({
      supplierId: group.supplierId,
      label: group.supplierId ? nameOf.get(group.supplierId) : undefined,
      count: group._count._all,
      priceSum: Number(group._sum.unit_price ?? 0),
    }));

    // A selected supplier with nothing left keeps its chip, with a zero.
    for (const id of filters.supplierIds ?? []) {
      if (nameOf.has(id) && !counts.some((entry) => entry.supplierId === id)) {
        counts.push({ supplierId: id, label: nameOf.get(id), count: 0, priceSum: 0 });
      }
    }

    return counts;
  }

  async updatePart({ partData, partId }: UpdatePart): Promise<Part> {
    // Separate the supplierId from the other fields of the part
    const { supplierId, ...partFields } = partData;

    // Filter empty fields
    const validPartFields = Object.fromEntries(
      Object.entries(partFields).filter(
        ([_, value]) => value !== undefined && value !== null && value !== "",
      ),
    );

    // Assemble data for update, preserving special treatment for supplierId
    const dataToUpdate = {
      ...validPartFields,
      ...(supplierId !== undefined ? { supplierId } : {}),
    };

    const updatePart = await this.prisma.part.update({
      where: { id: partId },
      data: dataToUpdate,
    });

    return updatePart;
  }

  async deletePart(partId: string): Promise<Part> {
    const deletePart = await this.prisma.part.delete({
      where: {
        id: partId,
      },
    });

    return deletePart;
  }

  async findPartById(partId: string): Promise<Part | null> {
    const findPartById = await this.prisma.part.findUnique({
      where: {
        id: partId,
      },
      include: {
        supplier: true,
      },
    });

    return findPartById;
  }

  async findPartByDescription(
    description: string,
    businessId: string,
    exceptPartId?: string,
  ): Promise<Part | null> {
    // Plain equality on the index key, not ILIKE: no pattern to escape, and
    // edge spaces count like FLEET-DUP-1's lower(btrim(description)).
    const [match] = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "part"
       WHERE "businessId" = ${businessId}
         AND lower(btrim("description")) = lower(btrim(${description}))
         ${exceptPartId ? Prisma.sql`AND "id" <> ${exceptPartId}` : Prisma.empty}
       LIMIT 1`;

    return match ? this.findPartById(match.id) : null;
  }

  async searchPartWithCursor({
    limit = 10,
    cursor,
    businessId,
    search,
  }: SearchPartWithCursorProps): Promise<CursorPaginatedPart> {
    const term = search?.trim();

    const items = await this.prisma.part.findMany({
      where: {
        businessId,
        ...(term &&
          buildSearchOr<Prisma.PartWhereInput>([
            { description: { contains: term, mode: "insensitive" } },
            { supplier: { name: { contains: term, mode: "insensitive" } } },
          ])),
      },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
      // The id breaks created_at ties, so a page boundary never repeats a row.
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    const hasMore = items.length > limit;

    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? (data[data.length - 1]?.id ?? null) : null;

    return { data, nextCursor, hasMore };
  }

  async countServiceOrderPartsByPartId(partId: string): Promise<number> {
    return this.prisma.serviceOrderPart.count({ where: { partId } });
  }
}

export { PartRepository };
