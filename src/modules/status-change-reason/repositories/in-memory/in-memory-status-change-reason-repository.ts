import { v7 as uuidV7 } from "uuid";

import { IStatusChangeReasonRepository } from "../IStatus-change-reason-repository";
import {
  StatusChangeReason,
  CreateStatusChangeReasonProps,
  UpdateStatusChangeReasonProps,
  ListStatusChangeReasonsProps,
  ListStatusChangeReasonsPage,
} from "../../dtos/status-change-reason-dto";

import { compareCodePoints, compareForOrder } from "@/shared/pagination/in-memory-order";
import { requireIndex, uniqueViolation } from "@/shared/in-memory/prisma-errors";
import { isActiveFilter } from "@/shared/delivery/catalog-list";
import {
  STATUS_REASON_SORT_FALLBACK,
  type StatusReasonGroup,
} from "../../usecases/list-status-change-reason/status-change-reason-list";

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

  /** @@unique([businessId, name]), case-sensitive like the index. */
  private assertUniqueName(candidate: StatusChangeReason): void {
    const taken = this.statusChangeReasons.some(
      (entry) =>
        entry.id !== candidate.id &&
        entry.businessId === candidate.businessId &&
        entry.name === candidate.name,
    );

    if (taken) throw uniqueViolation(["businessId", "name"]);
  }

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

    this.assertUniqueName(created);

    this.statusChangeReasons.push(created);

    return created;
  }

  /**
   * As statusReasonListWhere/STATUS_REASON_SORT: tenant, search on id, name
   * and description, the Status filter, ties by created_at desc, id desc, and
   * the counts over the search alone.
   */
  async listStatusChangeReasons({
    page,
    pageSize,
    businessId,
    search,
    sort,
    order,
    statuses,
  }: ListStatusChangeReasonsProps): Promise<ListStatusChangeReasonsPage> {
    const term = search?.trim().toLowerCase();

    const base = this.statusChangeReasons.filter(
      (reason) =>
        reason.businessId === businessId &&
        (!term ||
          [reason.id ?? "", reason.name, reason.description ?? ""].some(
            (value) => value.toLowerCase().includes(term),
          )),
    );

    const isActive = isActiveFilter(statuses);

    const key = sort ?? STATUS_REASON_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : STATUS_REASON_SORT_FALLBACK.order);

    const time = (value: Date | string | undefined) =>
      value === undefined ? undefined : new Date(value);

    const rows = base
      .filter(
        (reason) =>
          isActive === undefined || (reason.is_active !== false) === isActive,
      )
      .sort(
        (a, b) =>
          (key === "name"
            ? compareForOrder(a.name, b.name, direction)
            : compareForOrder(time(a[key]), time(b[key]), direction)) ||
          compareForOrder(time(a.created_at), time(b.created_at), "desc") ||
          compareForOrder(a.id, b.id, "desc"),
      );

    const groups = new Map<boolean, StatusReasonGroup>();

    for (const reason of base) {
      const active = reason.is_active !== false;
      const group = groups.get(active) ?? { is_active: active, count: 0 };

      group.count += 1;
      groups.set(active, group);
    }

    const skip = (page - 1) * pageSize;

    return {
      data: rows.slice(skip, skip + pageSize),
      groups: Array.from(groups.values()),
      used: base.filter(
        (reason) => (this.eventCountByReasonId.get(reason.id!) ?? 0) > 0,
      ).length,
    };
  }

  async listActiveStatusChangeReasons(
    businessId: string,
  ): Promise<Array<{ id: string; name: string; description: string | null }>> {
    return this.statusChangeReasons
      .filter(
        (reason) => reason.businessId === businessId && reason.is_active !== false,
      )
      // `orderBy: { name: "asc" }`: code point order, as Postgres sorts it.
      .sort((left, right) => compareCodePoints(left.name, right.name))
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

  async updateStatusChangeReason(
    reasonId: string,
    reasonData: UpdateStatusChangeReasonProps,
  ): Promise<StatusChangeReason> {
    // P2025 like Prisma; `find(...)!` used to crash with a TypeError.
    const reason =
      this.statusChangeReasons[requireIndex(this.statusChangeReasons, (entry) => entry.id === reasonId)];

    if (reasonData.name !== undefined && reasonData.name !== null) {
      this.assertUniqueName({ ...reason, name: reasonData.name });
    }

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
    // P2025 like Prisma; `splice(-1, 1)` used to delete the last reason.
    const index = requireIndex(
      this.statusChangeReasons,
      (reason) => reason.id === reasonId,
      "delete",
    );

    const [removed] = this.statusChangeReasons.splice(index, 1);

    return removed;
  }

  async countEventsByReasonId(reasonId: string): Promise<number> {
    return this.eventCountByReasonId.get(reasonId) ?? 0;
  }
}

export { InMemoryStatusChangeReasonRepository };
