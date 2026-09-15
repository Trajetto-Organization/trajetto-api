import { v7 as uuidV7 } from "uuid";

import { IStatusChangeReasonRepository } from "../IStatus-change-reason-repository";
import {
  StatusChangeReason,
  CreateStatusChangeReasonProps,
  UpdateStatusChangeReasonProps,
  ListStatusChangeReasonsProps,
  ListStatusChangeReasonsResult,
} from "../../dtos/status-change-reason-dto";

class InMemoryStatusChangeReasonRepository
  implements IStatusChangeReasonRepository
{
  public statusChangeReasons: StatusChangeReason[] = [];

  /**
   * How many events cite each reason.
   *
   * A test seam rather than a table: the events live in the delivery fake, and
   * wiring the two together for a count would be more machinery than the
   * question deserves. What matters is that a reason IN USE behaves as the
   * database makes it behave — the foreign key is ON DELETE RESTRICT.
   */
  public eventCountByReasonId = new Map<string, number>();

  async createStatusChangeReason(
    reasonData: CreateStatusChangeReasonProps,
  ): Promise<StatusChangeReason> {
    const created: StatusChangeReason = {
      id: uuidV7(),
      is_active: true,
      ...reasonData,
      description: reasonData.description || null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.statusChangeReasons.push(created);

    return created;
  }

  async listStatusChangeReasons({
    page,
    pageSize,
    businessId,
    search,
  }: ListStatusChangeReasonsProps): Promise<ListStatusChangeReasonsResult> {
    let filtered = this.statusChangeReasons.filter(
      (reason) => reason.businessId === businessId,
    );

    if (search) {
      const term = search.trim().toLowerCase();

      filtered = filtered.filter((reason) =>
        [reason.id ?? "", reason.name, reason.description ?? ""].some((value) =>
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

  async listActiveStatusChangeReasons(
    businessId: string,
  ): Promise<Array<{ id: string; name: string; description: string | null }>> {
    return this.statusChangeReasons
      .filter(
        (reason) => reason.businessId === businessId && reason.is_active !== false,
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((reason) => ({
        id: reason.id!,
        name: reason.name,
        description: reason.description ?? null,
      }));
  }

  async findStatusChangeReasonById(
    reasonId: string,
  ): Promise<StatusChangeReason | null> {
    return (
      this.statusChangeReasons.find((reason) => reason.id === reasonId) ?? null
    );
  }

  async findStatusChangeReasonByName(
    businessId: string,
    name: string,
  ): Promise<StatusChangeReason | null> {
    return (
      this.statusChangeReasons.find(
        (reason) => reason.businessId === businessId && reason.name === name,
      ) ?? null
    );
  }

  async countStatusChangeReasonsSummary(businessId: string): Promise<{
    total: number;
    active: number;
    used: number;
  }> {
    const own = this.statusChangeReasons.filter(
      (reason) => reason.businessId === businessId,
    );

    return {
      total: own.length,
      active: own.filter((reason) => reason.is_active !== false).length,
      used: own.filter(
        (reason) => (this.eventCountByReasonId.get(reason.id!) ?? 0) > 0,
      ).length,
    };
  }

  async updateStatusChangeReason(
    reasonId: string,
    reasonData: UpdateStatusChangeReasonProps,
  ): Promise<StatusChangeReason> {
    const reason = this.statusChangeReasons.find(
      (entry) => entry.id === reasonId,
    )!;

    Object.assign(reason, {
      ...(reasonData.name !== undefined &&
        reasonData.name !== null && { name: reasonData.name }),
      ...(reasonData.description !== undefined && {
        description: reasonData.description || null,
      }),
      ...(reasonData.is_active !== undefined && {
        is_active: reasonData.is_active,
      }),
      updated_at: new Date(),
    });

    return reason;
  }

  async deleteStatusChangeReason(
    reasonId: string,
  ): Promise<StatusChangeReason> {
    const index = this.statusChangeReasons.findIndex(
      (reason) => reason.id === reasonId,
    );

    const [removed] = this.statusChangeReasons.splice(index, 1);

    return removed;
  }

  async countEventsByReasonId(reasonId: string): Promise<number> {
    return this.eventCountByReasonId.get(reasonId) ?? 0;
  }
}

export { InMemoryStatusChangeReasonRepository };
