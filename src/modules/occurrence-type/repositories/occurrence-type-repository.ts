import { IOccurrenceTypeRepository } from "./IOccurrence-type-repository";
import {
  OccurrenceType,
  CreateOccurrenceTypeProps,
  UpdateOccurrenceTypeProps,
  ListOccurrenceTypesProps,
  ListOccurrenceTypesResult,
} from "../dtos/occurrence-type-dto";

import database from "@/../infra/database";

class OccurrenceTypeRepository implements IOccurrenceTypeRepository {
  constructor(private prisma = database) {}

  async createOccurrenceType(
    occurrenceTypeData: CreateOccurrenceTypeProps,
  ): Promise<OccurrenceType> {
    return this.prisma.occurrenceType.create({
      data: {
        ...occurrenceTypeData,
        description: occurrenceTypeData.description || null,
      },
    });
  }

  async listOccurrenceTypes({
    page,
    pageSize,
    businessId,
    search,
  }: ListOccurrenceTypesProps): Promise<ListOccurrenceTypesResult> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim() : "";

    const whereCondition = {
      businessId,
      ...(normalizedSearch && {
        OR: [
          { id: { contains: normalizedSearch, mode: "insensitive" as const } },
          { name: { contains: normalizedSearch, mode: "insensitive" as const } },
          {
            description: {
              contains: normalizedSearch,
              mode: "insensitive" as const,
            },
          },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.occurrenceType.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        orderBy: { created_at: "desc" },
      }),
      this.prisma.occurrenceType.count({ where: whereCondition }),
    ]);

    return { data, total };
  }

  async countOccurrenceTypesSummary(businessId: string): Promise<{
    total: number;
    active: number;
    blocking: number;
    requiringPhoto: number;
  }> {
    const [total, active, blocking, requiringPhoto] = await Promise.all([
      this.prisma.occurrenceType.count({ where: { businessId } }),
      this.prisma.occurrenceType.count({
        where: { businessId, is_active: true },
      }),
      this.prisma.occurrenceType.count({
        where: { businessId, blocks_delivery: true },
      }),
      this.prisma.occurrenceType.count({
        where: { businessId, requires_photo: true },
      }),
    ]);

    return { total, active, blocking, requiringPhoto };
  }

  async findOccurrenceTypeById(
    occurrenceTypeId: string,
  ): Promise<OccurrenceType | null> {
    return this.prisma.occurrenceType.findUnique({
      where: { id: occurrenceTypeId },
    });
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
    return this.prisma.occurrenceType.findMany({
      where: { businessId, is_active: true },
      select: {
        id: true,
        name: true,
        description: true,
        requires_photo: true,
        blocks_delivery: true,
      },
      orderBy: { name: "asc" },
    });
  }

  async findOccurrenceTypeByName(
    businessId: string,
    name: string,
  ): Promise<OccurrenceType | null> {
    return this.prisma.occurrenceType.findFirst({
      where: {
        businessId,
        name: { equals: name, mode: "insensitive" },
      },
    });
  }

  async updateOccurrenceType(
    occurrenceTypeId: string,
    occurrenceTypeData: UpdateOccurrenceTypeProps,
  ): Promise<OccurrenceType> {
    const filteredData = Object.fromEntries(
      Object.entries(occurrenceTypeData).filter(
        ([, value]) => value !== undefined,
      ),
    );

    return this.prisma.occurrenceType.update({
      where: { id: occurrenceTypeId },
      data: filteredData,
    });
  }

  async deleteOccurrenceType(
    occurrenceTypeId: string,
  ): Promise<OccurrenceType> {
    return this.prisma.occurrenceType.delete({
      where: { id: occurrenceTypeId },
    });
  }

  async countOccurrencesByTypeId(occurrenceTypeId: string): Promise<number> {
    return this.prisma.deliveryOccurrence.count({
      where: { occurrenceTypeId },
    });
  }
}

export { OccurrenceTypeRepository };
