import { Prisma } from "@prisma/client";

import { IOccurrenceTypeRepository } from "./IOccurrence-type-repository";
import {
  ActiveOccurrenceType,
  DeliveredOccurrenceType,
  OccurrenceType,
  OccurrenceTypeListRow,
  PauseOccurrenceType,
  CreateOccurrenceTypeProps,
  UpdateOccurrenceTypeProps,
  ListOccurrenceTypesProps,
  ListOccurrenceTypesPage,
} from "../dtos/occurrence-type-dto";

import database from "@/../infra/database";
import { systemFallbackName } from "./system-occurrence-type";
import { insensitiveEquals } from "@/shared/utils/like-pattern";
import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  OCCURRENCE_TYPE_SORT,
  occurrenceTypeListWhere,
} from "../usecases/list-occurrence-type/occurrence-type-list";
import {
  readFormFields,
  type OccurrenceFormField,
} from "../form/occurrence-form-rules";
import {
  DELIVERED_DEFAULT_TYPE_KEY,
  ensureDefaultOccurrenceTypes,
} from "@/shared/delivery/default-occurrence-types";
import { OccurrenceTypeLastOfCategoryError } from "../usecases/errors/occurrence-type-errors";

/**
 * A form as the Json column takes it: no form is SQL NULL (DbNull), not the
 * JSON literal null, so `form_fields IS NULL` keeps meaning "no form".
 */
function formFieldsColumn(
  fields: OccurrenceFormField[] | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return fields && fields.length > 0
    ? (fields as unknown as Prisma.InputJsonValue)
    : Prisma.DbNull;
}

/** The driver payload's columns of a type (the app reports offline from them). */
const ACTIVE_TYPE_SELECT = {
  id: true,
  name: true,
  description: true,
  requires_photo: true,
  blocks_delivery: true,
  requires_authorization: true,
  form_fields: true,
  form_version: true,
  category: true,
  requires_receipt_photo: true,
  requires_signature: true,
} as const;

/** A type as clients see it: the internal key becomes is_default. */
function toListRow(
  row: OccurrenceType,
  inUse: ReadonlySet<string>,
): OccurrenceTypeListRow {
  const { system_key, ...rest } = row;

  return { ...rest, is_default: system_key != null, in_use: inUse.has(row.id!) };
}

class OccurrenceTypeRepository implements IOccurrenceTypeRepository {
  constructor(private prisma = database) {}

  async ensureByName(
    businessId: string,
    data: {
      name: string;
      description: string;
      blocks_delivery: boolean;
      requires_photo: boolean;
    },
  ): Promise<{ id: string; name: string }> {
    // The platform's row is found by its flag, never by the name alone: a
    // company type that already carried this exact name used to be adopted
    // with is_system=false, so the rejections showed up in the driver's list
    // and in "Ocorrências hoje" (DLVP-OCC-3). That company row is left as it
    // is; the platform takes the fallback name instead.
    const names = [data.name, systemFallbackName(data.name)];

    const existing = await this.prisma.occurrenceType.findFirst({
      where: { businessId, is_system: true, name: { in: names } },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    });

    if (existing) return existing;

    let taken: { id: string; name: string } | null = null;

    for (const name of names) {
      // Insert-or-nothing on the (businessId, name) unique: two rejections
      // landing at the same moment both get the one row. Not
      // `upsert({ update: {} })`: with an empty update Prisma runs a SELECT
      // and an INSERT, and the loser of the race got P2002
      // (tests/E2E/get-or-create-races.test.ts).
      await this.prisma.occurrenceType.createMany({
        data: [
          {
            businessId,
            name,
            description: data.description,
            blocks_delivery: data.blocks_delivery,
            requires_photo: data.requires_photo,
            is_system: true,
          },
        ],
        skipDuplicates: true,
      });

      const row = await this.prisma.occurrenceType.findUniqueOrThrow({
        where: { businessId_name: { businessId, name } },
        select: { id: true, name: true, is_system: true },
      });

      if (row.is_system) return { id: row.id, name: row.name };

      taken ??= { id: row.id, name: row.name };
    }

    // Both names are the company's own types: the rejection still needs a
    // type to be recorded under, so it keeps the old adoption.
    return taken!;
  }

  async createOccurrenceType(
    occurrenceTypeData: CreateOccurrenceTypeProps,
  ): Promise<OccurrenceType> {
    const { form_fields, ...rest } = occurrenceTypeData;

    return this.prisma.occurrenceType.create({
      data: {
        ...rest,
        description: occurrenceTypeData.description || null,
        form_fields: formFieldsColumn(form_fields ?? null),
      },
    });
  }

  async listOccurrenceTypes({
    page,
    pageSize,
    sort,
    order,
    ...filters
  }: ListOccurrenceTypesProps): Promise<ListOccurrenceTypesPage> {
    // Two queries in parallel, the screen's connection budget: the page, and
    // one GROUP BY (at most 24 rows) that yields every count of the screen.
    const [data, grouped] = await Promise.all([
      this.prisma.occurrenceType.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: occurrenceTypeListWhere(filters, { withFacets: true }),
        orderBy: resolveOrderBy(OCCURRENCE_TYPE_SORT, { sort, order }),
      }),
      this.prisma.occurrenceType.groupBy({
        by: ["is_active", "blocks_delivery", "requires_photo", "category"],
        where: occurrenceTypeListWhere(filters, { withFacets: false }),
        _count: { _all: true },
      }),
    ]);

    const inUse = await this.typesInUse(data.map((row) => row.id));

    return {
      data: data.map((row) => toListRow(row, inUse)),
      groups: grouped.map((group) => ({
        is_active: group.is_active,
        blocks_delivery: group.blocks_delivery,
        requires_photo: group.requires_photo,
        category: group.category,
        count: group._count._all,
      })),
    };
  }

  /**
   * Which of these types something names. EXISTS per row, never a count: a
   * delivered type of a large carrier is named by millions of occurrences.
   */
  private async typesInUse(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT t."id"
        FROM "occurrence_type" t
       WHERE t."id" IN (${Prisma.join(ids)})
         AND (EXISTS (SELECT 1 FROM "delivery_occurrence" o WHERE o."occurrenceTypeId" = t."id")
           OR EXISTS (SELECT 1 FROM "driver_pause" p WHERE p."occurrenceTypeId" = t."id"))
    `;

    return new Set(rows.map((row) => row.id));
  }

  async isOccurrenceTypeInUse(occurrenceTypeId: string): Promise<boolean> {
    return (await this.typesInUse([occurrenceTypeId])).has(occurrenceTypeId);
  }

  async ensureDefaultTypes(businessId: string): Promise<void> {
    await ensureDefaultOccurrenceTypes(this.prisma, businessId);
  }

  async findDefaultType(
    businessId: string,
    systemKey: string,
  ): Promise<OccurrenceType | null> {
    return this.prisma.occurrenceType.findUnique({
      where: { businessId_system_key: { businessId, system_key: systemKey } },
    });
  }

  async findOccurrenceTypeById(
    occurrenceTypeId: string,
  ): Promise<OccurrenceType | null> {
    return this.prisma.occurrenceType.findUnique({
      where: { id: occurrenceTypeId },
    });
  }

  async listActiveOccurrenceTypes(
    businessId: string,
  ): Promise<ActiveOccurrenceType[]> {
    // What the driver may report as a problem: the company's active
    // NOT_DELIVERED types, never the platform's own (a rejected proof is not
    // something a driver files).
    const rows = await this.prisma.occurrenceType.findMany({
      where: { businessId, is_active: true, is_system: false, category: "NOT_DELIVERED" },
      select: ACTIVE_TYPE_SELECT,
      orderBy: { name: "asc" },
    });

    // The app renders the form offline from this copy: a stored definition
    // that no longer parses goes out as "no form", never as a broken list.
    return rows.map((row) => ({
      ...row,
      form_fields: readFormFields(row.form_fields),
    }));
  }

  async listActiveDeliveredTypes(
    businessId: string,
  ): Promise<DeliveredOccurrenceType[]> {
    const rows = await this.prisma.occurrenceType.findMany({
      where: { businessId, is_active: true, is_system: false, category: "DELIVERED" },
      select: { ...ACTIVE_TYPE_SELECT, system_key: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });

    // The default first: the app's one-tap path when it is the only one, and
    // the top of the picker otherwise. Array.sort is stable: names stay asc.
    return rows
      .map(({ system_key, ...row }) => ({
        ...row,
        form_fields: readFormFields(row.form_fields),
        is_default: system_key === DELIVERED_DEFAULT_TYPE_KEY,
      }))
      .sort((a, b) => Number(b.is_default) - Number(a.is_default));
  }

  async listActivePauseTypes(businessId: string): Promise<PauseOccurrenceType[]> {
    const rows = await this.prisma.occurrenceType.findMany({
      where: { businessId, is_active: true, category: "PAUSE", pause_kind: { not: null } },
      select: { id: true, name: true, pause_kind: true, system_key: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      pause_kind: row.pause_kind!,
      is_default: row.system_key !== null,
    }));
  }

  async findOccurrenceTypeByName(
    businessId: string,
    name: string,
  ): Promise<OccurrenceType | null> {
    return this.prisma.occurrenceType.findFirst({
      where: {
        businessId,
        // Escaped: the value is an ILIKE pattern underneath (like-pattern.ts).
        name: insensitiveEquals(name),
      },
    });
  }

  async updateOccurrenceType(
    occurrenceTypeId: string,
    occurrenceTypeData: UpdateOccurrenceTypeProps,
    options?: { keepOneActiveOf?: "DELIVERED" | "PAUSE" },
  ): Promise<OccurrenceType> {
    const { form_fields, ...rest } = occurrenceTypeData;

    const filteredData = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    );

    const write = (client: Prisma.TransactionClient) =>
      client.occurrenceType.update({
        where: { id: occurrenceTypeId },
        data: {
          ...filteredData,
          // A new form is a new version, in the same statement: two edits that
          // race both move the version, so an answer is never stored under a
          // number that names two different forms.
          ...(form_fields !== undefined && {
            form_fields: formFieldsColumn(form_fields),
            form_version: { increment: 1 },
          }),
        },
      });

    const category = options?.keepOneActiveOf;

    if (!category) return write(this.prisma);

    return this.prisma.$transaction(async (tx) => {
      await this.assertAnotherActive(tx, occurrenceTypeId, category);

      return write(tx);
    });
  }

  /**
   * The category's active rows under lock, in id order: a concurrent
   * deactivation or delete of another one waits here, then counts what this
   * left. Throws when `occurrenceTypeId` is the only one.
   */
  private async assertAnotherActive(
    tx: Prisma.TransactionClient,
    occurrenceTypeId: string,
    category: "DELIVERED" | "PAUSE",
  ): Promise<void> {
    const { businessId } = await tx.occurrenceType.findUniqueOrThrow({
      where: { id: occurrenceTypeId },
      select: { businessId: true },
    });

    const active = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "occurrence_type"
       WHERE "businessId" = ${businessId}
         AND "category" = ${category}::"OccurrenceCategory"
         AND "is_active" = true
       ORDER BY "id"
       FOR UPDATE
    `;

    if (!active.some((row) => row.id !== occurrenceTypeId)) {
      throw new OccurrenceTypeLastOfCategoryError(category);
    }
  }

  async deleteOccurrenceType(
    occurrenceTypeId: string,
    options?: { keepOneActiveOf?: "DELIVERED" | "PAUSE" },
  ): Promise<OccurrenceType> {
    const category = options?.keepOneActiveOf;

    if (!category) {
      return this.prisma.occurrenceType.delete({ where: { id: occurrenceTypeId } });
    }

    return this.prisma.$transaction(async (tx) => {
      await this.assertAnotherActive(tx, occurrenceTypeId, category);

      return tx.occurrenceType.delete({ where: { id: occurrenceTypeId } });
    });
  }
}

export { OccurrenceTypeRepository };
