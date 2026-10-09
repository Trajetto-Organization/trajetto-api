import { IStatusChangeReasonRepository } from "./IStatus-change-reason-repository";
import {
  StatusChangeReason,
  CreateStatusChangeReasonProps,
  UpdateStatusChangeReasonProps,
  ListStatusChangeReasonsProps,
  ListStatusChangeReasonsPage,
} from "../dtos/status-change-reason-dto";

import database from "@/../infra/database";
import { resolveOrderBy } from "@/shared/pagination/list-query";

import {
  STATUS_REASON_SORT,
  statusReasonListWhere,
} from "../usecases/list-status-change-reason/status-change-reason-list";

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
    sort,
    order,
    ...filters
  }: ListStatusChangeReasonsProps): Promise<ListStatusChangeReasonsPage> {
    const base = statusReasonListWhere(filters, { withFacets: false });

    // The page and the per-status GROUP BY in parallel (the screen's budget
    // of two connections), then the "Em uso" card, sequential.
    const [data, grouped] = await Promise.all([
      this.prisma.statusChangeReason.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: statusReasonListWhere(filters, { withFacets: true }),
        orderBy: resolveOrderBy(STATUS_REASON_SORT, { sort, order }),
      }),
      this.prisma.statusChangeReason.groupBy({
        by: ["is_active"],
        where: base,
        _count: { _all: true },
      }),
    ]);

    // "Used" is the one number that tells an operator which entries of the
    // catalogue are real vocabulary and which were typed once and forgotten.
    const used = await this.prisma.statusChangeReason.count({
      where: { AND: [base, { events: { some: {} } }] },
    });

    return {
      data,
      groups: grouped.map((group) => ({
        is_active: group.is_active,
        count: group._count._all,
      })),
      used,
    };
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
