import { v7 as uuidV7 } from "uuid";
import { IOccurrenceTypeRepository } from "../IOccurrence-type-repository";

import {
  OccurrenceType,
  CreateOccurrenceTypeProps,
  UpdateOccurrenceTypeProps,
  ListOccurrenceTypesProps,
  ListOccurrenceTypesResult,
} from "../../dtos/occurrence-type-dto";

class InMemoryOccurrenceTypeRepository implements IOccurrenceTypeRepository {
  public occurrenceTypes: OccurrenceType[] = [];
  public occurrenceCounts = new Map<string, number>();

  async ensureByName(
    businessId: string,
    data: {
      name: string;
      description: string;
      blocks_delivery: boolean;
      requires_photo: boolean;
    },
  ): Promise<{ id: string; name: string }> {
    const existing = this.occurrenceTypes.find(
      (entry) => entry.businessId === businessId && entry.name === data.name,
    );

    // A company that renamed or retired this type made a decision about their
    // own catalogue; a system occurrence does not undo it.
    if (existing) return { id: existing.id!, name: existing.name };

    const created = await this.createOccurrenceType({
      businessId,
      name: data.name,
      description: data.description,
      blocks_delivery: data.blocks_delivery,
      requires_photo: data.requires_photo,
    } as never);

    return { id: created.id!, name: created.name };
  }

  async createOccurrenceType(
    occurrenceTypeData: CreateOccurrenceTypeProps,
  ): Promise<OccurrenceType> {
    const newOccurrenceType: OccurrenceType = {
      id: uuidV7(),
      requires_photo: false,
      blocks_delivery: false,
      ...occurrenceTypeData,
      description: occurrenceTypeData.description || null,
      is_active: true,
    };

    this.occurrenceTypes.push(newOccurrenceType);
    return newOccurrenceType;
  }

  async listOccurrenceTypes({
    page,
    pageSize,
    businessId,
    search,
  }: ListOccurrenceTypesProps): Promise<ListOccurrenceTypesResult> {
    let filtered = this.occurrenceTypes.filter(
      (o) => o.businessId === businessId,
    );

    if (search) {
      const term = search.trim().toLowerCase();
      filtered = filtered.filter((o) =>
        [o.name, o.description ?? ""].some((value) =>
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

  async countOccurrenceTypesSummary(businessId: string): Promise<{
    total: number;
    active: number;
    blocking: number;
    requiringPhoto: number;
  }> {
    const owned = this.occurrenceTypes.filter(
      (o) => o.businessId === businessId,
    );

    return {
      total: owned.length,
      active: owned.filter((o) => o.is_active !== false).length,
      blocking: owned.filter((o) => o.blocks_delivery === true).length,
      requiringPhoto: owned.filter((o) => o.requires_photo === true).length,
    };
  }

  async findOccurrenceTypeById(
    occurrenceTypeId: string,
  ): Promise<OccurrenceType | null> {
    return this.occurrenceTypes.find((o) => o.id === occurrenceTypeId) ?? null;
  }

  async listActiveOccurrenceTypes(businessId: string): Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
      requires_photo: boolean;
      blocks_delivery: boolean;
    }>
  > {
    return this.occurrenceTypes
      .filter((type) => type.businessId === businessId && type.is_active)
      .map((type) => ({
        id: type.id!,
        name: type.name,
        description: type.description ?? null,
        requires_photo: type.requires_photo ?? false,
        blocks_delivery: type.blocks_delivery ?? false,
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
  ): Promise<OccurrenceType> {
    const index = this.occurrenceTypes.findIndex(
      (o) => o.id === occurrenceTypeId,
    );

    const filteredData = Object.fromEntries(
      Object.entries(occurrenceTypeData).filter(
        ([, value]) => value !== undefined,
      ),
    );

    this.occurrenceTypes[index] = {
      ...this.occurrenceTypes[index],
      ...filteredData,
    };

    return this.occurrenceTypes[index];
  }

  async deleteOccurrenceType(
    occurrenceTypeId: string,
  ): Promise<OccurrenceType> {
    const index = this.occurrenceTypes.findIndex(
      (o) => o.id === occurrenceTypeId,
    );

    return this.occurrenceTypes.splice(index, 1)[0];
  }

  async countOccurrencesByTypeId(occurrenceTypeId: string): Promise<number> {
    return this.occurrenceCounts.get(occurrenceTypeId) ?? 0;
  }
}

export { InMemoryOccurrenceTypeRepository };
