import { IStatusChangeReasonRepository } from "./IStatus-change-reason-repository";
import {
  StatusChangeReason,
  CreateStatusChangeReasonProps,
  UpdateStatusChangeReasonProps,
  ListStatusChangeReasonsProps,
  ListStatusChangeReasonsResult,
} from "../dtos/status-change-reason-dto";

import database from "@/../infra/database";

class StatusChangeReasonRepository implements IStatusChangeReasonRepository {
  constructor(private prisma = database) {}

  async createStatusChangeReason(
    reasonData: CreateStatusChangeReasonProps,
  ): Promise<StatusChangeReason> {
    return this.prisma.statusChangeReason.create({
      data: {
        ...reasonData,
        description: reasonData.description || null,
      },
    });
  }

  async listStatusChangeReasons({
    page,
    pageSize,
    businessId,
    search,
  }: ListStatusChangeReasonsProps): Promise<ListStatusChangeReasonsResult> {
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
      this.prisma.statusChangeReason.findMany({
        skip,
        take: pageSize,
        where: whereCondition,
        orderBy: { created_at: "desc" },
      }),
      this.prisma.statusChangeReason.count({ where: whereCondition }),
    ]);

    return { data, total };
  }

  async listActiveStatusChangeReasons(
    businessId: string,
  ): Promise<Array<{ id: string; name: string; description: string | null }>> {
    return this.prisma.statusChangeReason.findMany({
      where: { businessId, is_active: true },
      select: { id: true, name: true, description: true },
      orderBy: { name: "asc" },
    });
  }

  async findStatusChangeReasonById(
    reasonId: string,
  ): Promise<StatusChangeReason | null> {
    return this.prisma.statusChangeReason.findUnique({
      where: { id: reasonId },
    });
  }

  async findStatusChangeReasonByName(
    businessId: string,
    name: string,
  ): Promise<StatusChangeReason | null> {
    return this.prisma.statusChangeReason.findUnique({
      where: { businessId_name: { businessId, name } },
    });
  }

  /**
   * The cards above the catalogue, over the whole company rather than the page
   * on screen — a card that counts the current page reports ten rows as if
   * they were everything and changes every time the user pages.
   */
  async countStatusChangeReasonsSummary(businessId: string): Promise<{
    total: number;
    active: number;
    used: number;
  }> {
    const [total, active, used] = await Promise.all([
      this.prisma.statusChangeReason.count({ where: { businessId } }),
      this.prisma.statusChangeReason.count({
        where: { businessId, is_active: true },
      }),
      // "Used" is the one number that tells an operator which entries of the
      // catalogue are real vocabulary and which were typed once and forgotten.
      this.prisma.statusChangeReason.count({
        where: { businessId, events: { some: {} } },
      }),
    ]);

    return { total, active, used };
  }

  async updateStatusChangeReason(
    reasonId: string,
    reasonData: UpdateStatusChangeReasonProps,
  ): Promise<StatusChangeReason> {
    return this.prisma.statusChangeReason.update({
      where: { id: reasonId },
      data: {
        ...(reasonData.name !== undefined &&
          reasonData.name !== null && { name: reasonData.name }),
        ...(reasonData.description !== undefined && {
          description: reasonData.description || null,
        }),
        ...(reasonData.is_active !== undefined && {
          is_active: reasonData.is_active,
        }),
      },
    });
  }

  async deleteStatusChangeReason(
    reasonId: string,
  ): Promise<StatusChangeReason> {
    return this.prisma.statusChangeReason.delete({ where: { id: reasonId } });
  }

  async countEventsByReasonId(reasonId: string): Promise<number> {
    return this.prisma.deliveryEvent.count({ where: { reasonId } });
  }
}

export { StatusChangeReasonRepository };
