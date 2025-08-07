import { IPartRepository } from "./IPart-repository";
import {
  Part,
  CreatePartProps,
  ListPartByBusinessIdProps,
  ListPartProps,
  UpdatePart,
  ListPartBusinessProps,
} from "../dtos/part-dto";

import database from "@/../infra/database";
import { formatDate, formatCurrency } from "@/config/format-values";

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
    businessId,
    currentUserRole,
    search,
  }: ListPartByBusinessIdProps): Promise<ListPartProps> {
    const skip = (page - 1) * pageSize;
    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const orConditions: any[] = [];

    if (normalizedSearch) {
      orConditions.push(
        { id: { contains: normalizedSearch, mode: "insensitive" } },
        { description: { contains: normalizedSearch, mode: "insensitive" } },
      );
    }

    const whereCondition = {
      ...(currentUserRole !== "MASTER" && { businessId: businessId }),
      ...(orConditions.length > 0 && { OR: orConditions }),
    };

    const partData = await this.prisma.part.findMany({
      skip,
      take: pageSize,
      where: whereCondition,
      include: {
        supplier: {
          select: {
            name: true,
          },
        },
        business: {
          select: {
            corporate_reason: true,
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });

    const total = await this.prisma.part.count({
      where: whereCondition,
    });

    const transformedPartData = partData.map((part) => ({
      id: part.id ?? "N/A",
      description: part.description ?? "N/A",
      unit_price: formatCurrency(Number(part.unit_price)) ?? "N/A",
      ...(currentUserRole === "MASTER"
        ? { businessId: part.businessId ?? "N/A" }
        : {}),
      ...(currentUserRole === "MASTER"
        ? { business_name: part.business?.corporate_reason ?? "N/A" }
        : {}),
      supplierId: part.supplierId ?? null,
      supplierName: part.supplier?.name ?? "N/A",
      created_at: formatDate(part.created_at, "pt-BR") ?? "N/A",
      updated_at: formatDate(part.updated_at, "pt-BR") ?? "N/A",
    }));

    return {
      data: transformedPartData,
      total,
    };
  }

  async listPartBusiness({
    page,
    pageSize,
    businessId,
  }: ListPartBusinessProps): Promise<ListPartProps> {
    const skip = (page - 1) * pageSize;

    const serviceOrderBusinessData = await this.prisma.part.findMany({
      skip,
      take: pageSize,
      where: {
        businessId,
      },
    });

    const total = await this.prisma.part.count({
      where: {
        businessId,
      },
    });

    return { data: serviceOrderBusinessData, total };
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
  ): Promise<Part | null> {
    const findPartByDescription = await this.prisma.part.findFirst({
      where: {
        description: {
          equals: description,
          mode: "insensitive",
        },
        businessId: businessId,
      },
    });

    return findPartByDescription;
  }

  async findServiceOrderPartsByPartId(partId: string): Promise<any[]> {
    const serviceOrderParts = await this.prisma.serviceOrderPart.findMany({
      where: { partId },
      include: {
        serviceOrder: {
          select: {
            id: true,
            date: true,
            vehicle: {
              select: {
                license_plate: true,
                description: true,
              },
            },
          },
        },
      },
    });

    return serviceOrderParts;
  }
}

export { PartRepository };
