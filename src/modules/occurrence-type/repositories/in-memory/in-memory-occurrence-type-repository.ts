import { v7 as uuidV7 } from "uuid";
import { IOccurrenceTypeRepository } from "../IOccurrence-type-repository";
import { systemFallbackName } from "../system-occurrence-type";

import {
  OCCURRENCE_TYPE_COLUMN_DEFAULTS,
  withColumnDefaults,
} from "@/shared/in-memory/column-defaults";

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
} from "../../dtos/occurrence-type-dto";
import { readFormFields } from "../../form/occurrence-form-rules";

import { compareForOrder } from "@/shared/pagination/in-memory-order";
import { isActiveFilter, yesNoFilter } from "@/shared/delivery/catalog-list";
import {
  OCCURRENCE_TYPE_SORT_FALLBACK,
  categoryFilter,
  type OccurrenceTypeGroup,
} from "../../usecases/list-occurrence-type/occurrence-type-list";
import {
  DEFAULT_OCCURRENCE_TYPES,
  DELIVERED_DEFAULT_TYPE_KEY,
} from "@/shared/delivery/default-occurrence-types";
import { OccurrenceTypeLastOfCategoryError } from "../../usecases/errors/occurrence-type-errors";
import { requireIndex, uniqueViolation } from "@/shared/in-memory/prisma-errors";

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

class InMemoryOccurrenceTypeRepository implements IOccurrenceTypeRepository {
  public occurrenceTypes: OccurrenceType[] = [];
  /** Occurrences AND pauses naming each type (what RESTRICTs a delete). */
  public occurrenceCounts = new Map<string, number>();
  /**
   * Companies that exist, for ensureDefaultTypes: the SQL seeds only a
   * business row that exists. Empty = every company asked about exists.
   */
  public businessIds = new Set<string>();

  async ensureByName(
    businessId: string,
    data: {
      name: string;
      description: string;
      blocks_delivery: boolean;
      requires_photo: boolean;
    },
  ): Promise<{ id: string; name: string }> {
    // Same rules as Prisma: the platform's row is found by its flag, and a
    // company type holding the name sends the platform to the fallback name.
    const names = [data.name, systemFallbackName(data.name)];

    const existing = this.occurrenceTypes
      .filter(
        (entry) =>
          entry.businessId === businessId &&
          entry.is_system === true &&
          names.includes(entry.name),
      )
      .sort(
        (a, b) =>
          new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime() ||
          (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0),
      )[0];

    if (existing) return { id: existing.id!, name: existing.name };

    let taken: { id: string; name: string } | null = null;

    for (const name of names) {
      const holder = this.occurrenceTypes.find(
        (entry) => entry.businessId === businessId && entry.name === name,
      );

      if (!holder) {
        const created = await this.createOccurrenceType({
          businessId,
          name,
          description: data.description,
          blocks_delivery: data.blocks_delivery,
          requires_photo: data.requires_photo,
          is_system: true,
        } as never);

        return { id: created.id!, name: created.name };
      }

      if (holder.is_system) return { id: holder.id!, name: holder.name };

      taken ??= { id: holder.id!, name: holder.name };
    }

    return taken!;
  }

  async createOccurrenceType(
    occurrenceTypeData: CreateOccurrenceTypeProps,
  ): Promise<OccurrenceType> {
    // The (businessId, name) unique, as Postgres enforces it.
    if (
      this.occurrenceTypes.some(
        (entry) =>
          entry.businessId === occurrenceTypeData.businessId &&
          entry.name === occurrenceTypeData.name,
      )
    ) {
      throw uniqueViolation(["businessId", "name"]);
    }

    const now = new Date();

    const newOccurrenceType: OccurrenceType = {
      id: uuidV7(),
      // DEFAULT now() / @updatedAt, as the INSERT gets them.
      created_at: now,
      updated_at: now,
      ...withColumnDefaults(OCCURRENCE_TYPE_COLUMN_DEFAULTS, occurrenceTypeData),
      description: occurrenceTypeData.description || null,
      // No form is SQL NULL in the column (DbNull), [] included.
      form_fields: occurrenceTypeData.form_fields?.length
        ? occurrenceTypeData.form_fields
        : null,
      is_active: true,
    };

    this.occurrenceTypes.push(newOccurrenceType);
    return newOccurrenceType;
  }

  /**
   * As occurrenceTypeListWhere/OCCURRENCE_TYPE_SORT: tenant, search on id,
   * name and description, the four filters, ties by created_at desc, id desc,
   * and the counts grouped over the search alone.
   */
  async listOccurrenceTypes({
    page,
    pageSize,
    businessId,
    search,
    sort,
    order,
    statuses,
    blocking,
    photo,
    categories,
  }: ListOccurrenceTypesProps): Promise<ListOccurrenceTypesPage> {
    const term = search?.trim().toLowerCase();

    const base = this.occurrenceTypes.filter(
      (o) =>
        o.businessId === businessId &&
        (!term ||
          [o.id ?? "", o.name, o.description ?? ""].some((value) =>
            value.toLowerCase().includes(term),
          )),
    );

    const isActive = isActiveFilter(statuses);
    const blocks = yesNoFilter(blocking);
    const needsPhoto = yesNoFilter(photo);
    const inCategories = categoryFilter(categories);

    const key = sort ?? OCCURRENCE_TYPE_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : OCCURRENCE_TYPE_SORT_FALLBACK.order);

    const time = (value: Date | string | undefined) =>
      value === undefined ? undefined : new Date(value);

    const rows = base
      .filter(
        (o) =>
          (isActive === undefined || (o.is_active !== false) === isActive) &&
          (blocks === undefined || (o.blocks_delivery === true) === blocks) &&
          (needsPhoto === undefined || (o.requires_photo === true) === needsPhoto) &&
          (inCategories === undefined ||
            inCategories.includes(o.category ?? "NOT_DELIVERED")),
      )
      .sort(
        (a, b) =>
          (key === "name"
            ? compareForOrder(a.name, b.name, direction)
            : compareForOrder(time(a[key]), time(b[key]), direction)) ||
          compareForOrder(time(a.created_at), time(b.created_at), "desc") ||
          compareForOrder(a.id, b.id, "desc"),
      );

    const groups = new Map<string, OccurrenceTypeGroup>();

    for (const o of base) {
      const values = {
        is_active: o.is_active !== false,
        blocks_delivery: o.blocks_delivery === true,
        requires_photo: o.requires_photo === true,
        category: o.category ?? "NOT_DELIVERED",
      };

      const id = JSON.stringify(values);
      const group = groups.get(id) ?? { ...values, count: 0 };

      group.count += 1;
      groups.set(id, group);
    }

    const skip = (page - 1) * pageSize;

    return {
      data: rows.slice(skip, skip + pageSize).map((row) => this.toListRow(row)),
      groups: Array.from(groups.values()),
    };
  }

  private toListRow(row: OccurrenceType): OccurrenceTypeListRow {
    const { system_key, ...rest } = row;

    return {
      ...rest,
      is_default: system_key != null,
      in_use: (this.occurrenceCounts.get(row.id!) ?? 0) > 0,
    };
  }

  async isOccurrenceTypeInUse(occurrenceTypeId: string): Promise<boolean> {
    return (this.occurrenceCounts.get(occurrenceTypeId) ?? 0) > 0;
  }

  /** As ensureDefaultOccurrenceTypes: missing keys only, the first free name. */
  async ensureDefaultTypes(businessId: string): Promise<void> {
    if (this.businessIds.size > 0 && !this.businessIds.has(businessId)) return;

    for (const seed of DEFAULT_OCCURRENCE_TYPES) {
      const exists = this.occurrenceTypes.some(
        (type) => type.businessId === businessId && type.system_key === seed.system_key,
      );

      if (exists) continue;

      const taken = (name: string) =>
        this.occurrenceTypes.some((type) => type.businessId === businessId && type.name === name);

      let name = seed.name;

      for (let n = 1; taken(name); n += 1) {
        name = n === 1 ? `${seed.name} (padrão)` : `${seed.name} (padrão ${n})`;
      }

      const now = new Date();

      this.occurrenceTypes.push({
        ...OCCURRENCE_TYPE_COLUMN_DEFAULTS,
        id: uuidV7(),
        businessId,
        name,
        description: seed.description,
        category: seed.category,
        requires_receipt_photo: seed.requires_receipt_photo,
        pause_kind: seed.pause_kind,
        system_key: seed.system_key,
        is_active: true,
        created_at: now,
        updated_at: now,
      });
    }
  }

  async findDefaultType(
    businessId: string,
    systemKey: string,
  ): Promise<OccurrenceType | null> {
    return (
      this.occurrenceTypes.find(
        (type) => type.businessId === businessId && type.system_key === systemKey,
      ) ?? null
    );
  }

  async findOccurrenceTypeById(
    occurrenceTypeId: string,
  ): Promise<OccurrenceType | null> {
    return this.occurrenceTypes.find((o) => o.id === occurrenceTypeId) ?? null;
  }

  private activeOf(type: OccurrenceType): ActiveOccurrenceType {
    return {
      id: type.id!,
      name: type.name,
      description: type.description ?? null,
      requires_photo: type.requires_photo ?? false,
      blocks_delivery: type.blocks_delivery ?? false,
      requires_authorization: type.requires_authorization ?? false,
      form_fields: readFormFields(type.form_fields),
      form_version: type.form_version ?? 1,
      category: type.category ?? "NOT_DELIVERED",
      requires_receipt_photo: type.requires_receipt_photo ?? false,
      requires_signature: type.requires_signature ?? false,
    };
  }

  async listActiveOccurrenceTypes(
    businessId: string,
  ): Promise<ActiveOccurrenceType[]> {
    return this.occurrenceTypes
      .filter(
        (type) =>
          type.businessId === businessId &&
          type.is_active &&
          !type.is_system &&
          (type.category ?? "NOT_DELIVERED") === "NOT_DELIVERED",
      )
      // orderBy name asc, like the query.
      .sort(byName)
      .map((type) => this.activeOf(type));
  }

  async listActiveDeliveredTypes(
    businessId: string,
  ): Promise<DeliveredOccurrenceType[]> {
    return this.occurrenceTypes
      .filter(
        (type) =>
          type.businessId === businessId &&
          type.is_active &&
          !type.is_system &&
          type.category === "DELIVERED",
      )
      .sort((a, b) => byName(a, b) || compareForOrder(a.id, b.id, "asc"))
      .map((type) => ({
        ...this.activeOf(type),
        is_default: type.system_key === DELIVERED_DEFAULT_TYPE_KEY,
      }))
      .sort((a, b) => Number(b.is_default) - Number(a.is_default));
  }

  async listActivePauseTypes(businessId: string): Promise<PauseOccurrenceType[]> {
    return this.occurrenceTypes
      .filter(
        (type) =>
          type.businessId === businessId &&
          type.is_active &&
          type.category === "PAUSE" &&
          type.pause_kind != null,
      )
      .sort((a, b) => byName(a, b) || compareForOrder(a.id, b.id, "asc"))
      .map((type) => ({
        id: type.id!,
        name: type.name,
        pause_kind: type.pause_kind!,
        is_default: type.system_key != null,
      }));
  }

  async findOccurrenceTypeByName(
    businessId: string,
    name: string,
  ): Promise<OccurrenceType | null> {
    return (
      this.occurrenceTypes.find(
        (o) =>
          o.businessId === businessId &&
          o.name.toLowerCase() === name.toLowerCase(),
      ) ?? null
    );
  }

  async updateOccurrenceType(
    occurrenceTypeId: string,
    occurrenceTypeData: UpdateOccurrenceTypeProps,
    options?: { keepOneActiveOf?: "DELIVERED" | "PAUSE" },
  ): Promise<OccurrenceType> {
    // P2025 like Prisma's update; index -1 used to write `array[-1]`.
    const index = requireIndex(this.occurrenceTypes, (o) => o.id === occurrenceTypeId);

    const current = this.occurrenceTypes[index];
    const category = options?.keepOneActiveOf;

    // As the Prisma write's locked count of the category's active rows.
    if (
      category &&
      !this.occurrenceTypes.some(
        (o) =>
          o.businessId === current.businessId &&
          o.category === category &&
          o.is_active !== false &&
          o.id !== occurrenceTypeId,
      )
    ) {
      throw new OccurrenceTypeLastOfCategoryError(category);
    }

    const { form_fields, ...rest } = occurrenceTypeData;

    const filteredData = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    );

    this.occurrenceTypes[index] = {
      ...current,
      ...filteredData,
      // As the Prisma update: a new form is written with form_version + 1.
      ...(form_fields !== undefined && {
        form_fields: form_fields?.length ? form_fields : null,
        form_version: (current.form_version ?? 1) + 1,
      }),
      // @updatedAt, as Prisma writes it: the "Data de atualização" sort.
      updated_at: new Date(),
    };

    return this.occurrenceTypes[index];
  }

  async deleteOccurrenceType(
    occurrenceTypeId: string,
    options?: { keepOneActiveOf?: "DELIVERED" | "PAUSE" },
  ): Promise<OccurrenceType> {
    // P2025 like Prisma's delete; `splice(-1, 1)` used to drop the last type.
    const index = requireIndex(
      this.occurrenceTypes,
      (o) => o.id === occurrenceTypeId,
      "delete",
    );

    const current = this.occurrenceTypes[index];
    const category = options?.keepOneActiveOf;

    // As the Prisma delete's locked check of the category's active rows.
    if (
      category &&
      !this.occurrenceTypes.some(
        (o) =>
          o.businessId === current.businessId &&
          o.category === category &&
          o.is_active !== false &&
          o.id !== occurrenceTypeId,
      )
    ) {
      throw new OccurrenceTypeLastOfCategoryError(category);
    }

    return this.occurrenceTypes.splice(index, 1)[0];
  }
}

export { InMemoryOccurrenceTypeRepository };
