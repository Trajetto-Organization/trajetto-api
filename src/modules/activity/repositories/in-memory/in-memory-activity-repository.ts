import { v7 as uuidV7 } from "uuid";
import { IActivityRepository } from "../IActivity-repository";

import {
  Activity,
  ActivityListFilters,
  ActivitySummary,
  ActivitySummaryProps,
  CreateActivityProps,
  CursorPaginatedActivities,
  ListActivitiesCursorProps,
  ListActivityProps,
  ListRecentActivitiesProps,
  ListRecentActivitiesPreviewProps,
} from "../../dtos/activity-dto";

import { presentActivityActors } from "@/shared/activity/actor-presentation";
import { TENANT_VISIBLE } from "@/shared/notifications/policies/business-plan-policies";

import {
  businessDaysRange,
  DEFAULT_BUSINESS_TIMEZONE,
  resolveTimeZone,
} from "@/shared/time/business-day";

import { compareForOrder } from "@/shared/pagination/in-memory-order";
import { afterCursor } from "@/shared/in-memory/cursor";

import { canonicalStatus, storedStatusesFor } from "../../activity-catalog";

/** The user row as the repository joins it. */
interface ActorRow {
  role: string;
  businessId: string | null;
  driverId: string | null;
  name: string;
  email: string;
}

type ActivityRow = Activity & {
  user?: {
    email: string;
    role: string;
    name: string;
    driverId: string | null;
  } | null;
  business?: { corporate_reason: string } | null;
};

/** Postgres ILIKE '%term%' after literalContains: a plain case-insensitive substring. */
const containsInsensitive = (value: string | null | undefined, term: string) =>
  (value ?? "").toLowerCase().includes(term.toLowerCase());

const time = (value: Date | string) => new Date(value).getTime();

/** `orderBy: { id: "desc" }` (uuid v7: creation order). */
const byIdDesc = (a: Activity, b: Activity) =>
  compareForOrder(a.id, b.id, "desc");

/**
 * The activity table in memory, answering as ActivityRepository does
 * (decision 13.2): the same visibility rules per role, the facets, the
 * business-day period, the (created_at, id) order and the actor
 * presentation. Seed `users` and `businesses` for what the joins read; an
 * author with no user row is a system action (the column is SET NULL).
 */
class InMemoryActivityRepository implements IActivityRepository {
  public activities: Activity[] = [];

  /** The user table, for the role/driver joins and the author columns. */
  public users = new Map<string, ActorRow>();

  /** The business table: zone for the period, name for the MASTER column. */
  public businesses = new Map<
    string,
    { timezone?: string; corporate_reason: string }
  >();

  // The transaction is the real repository's concern; here every write lands.
  async createActivity(
    activityData: CreateActivityProps,
    _tx?: unknown,
  ): Promise<Activity> {
    // Mirrors the upsert in the Prisma repository. Without it the fake would
    // accept a second write that the real one collapses, and a test proving
    // the pipeline is idempotent would be proving the opposite.
    if (activityData.deliveryId) {
      const existing = this.activities.find(
        (entry) => entry.deliveryId === activityData.deliveryId,
      );

      if (existing) return existing;
    }

    const activity: Activity = {
      id: uuidV7(),
      deliveryId: activityData.deliveryId ?? null,
      type: activityData.type,
      action: activityData.action,
      entityId: activityData.entityId,
      description: activityData.description,
      // The repository stores one spelling per status.
      status: canonicalStatus(activityData.status),
      performedBy: activityData.performedBy,
      businessId: activityData.businessId,
      tenantName:
        activityData.tenantName ??
        (activityData.businessId
          ? (this.businesses.get(activityData.businessId)?.corporate_reason ??
            null)
          : null),
      visibilityLevel: activityData.visibilityLevel || "COMPANY",
      performingUserRole: activityData.performingUserRole || null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.activities.push(activity);
    return activity;
  }

  /** A row seeded as-is (a fixed date, a legacy status spelling). */
  addActivity(activityData: Partial<Activity>): Activity {
    const activity: Activity = {
      id: activityData.id || uuidV7(),
      deliveryId: activityData.deliveryId ?? null,
      type: activityData.type || "test",
      action: activityData.action || "create",
      entityId: activityData.entityId || "entity-id",
      description: activityData.description || "Test activity",
      status: activityData.status || "Completo",
      performedBy: activityData.performedBy ?? null,
      businessId: activityData.businessId || null,
      tenantName: activityData.tenantName ?? null,
      visibilityLevel: activityData.visibilityLevel || "COMPANY",
      performingUserRole: activityData.performingUserRole || null,
      created_at: activityData.created_at || new Date(),
      updated_at: activityData.updated_at || new Date(),
    };

    this.activities.push(activity);
    return activity;
  }

  getActivitiesByBusinessId(businessId: string): Activity[] {
    return this.activities.filter(
      (activity) => activity.businessId === businessId,
    );
  }

  getActivitiesByUserId(userId: string): Activity[] {
    return this.activities.filter(
      (activity) => activity.performedBy === userId,
    );
  }

  private author(activity: Activity): ActorRow | null {
    return activity.performedBy
      ? (this.users.get(activity.performedBy) ?? null)
      : null;
  }

  private matchesRole(activity: Activity, role: string): boolean {
    const author = this.author(activity);

    if (!author) return false;

    switch (role) {
      case "MASTER":
      case "PLATFORM":
        return author.role === "MASTER";
      case "BUSINESS_ADMIN":
        return author.role === "BUSINESS_ADMIN";
      case "DRIVER":
        return author.role === "BUSINESS_USER" && author.driverId !== null;
      default:
        return author.role === "BUSINESS_USER" && author.driverId === null;
    }
  }

  /** `NOT (user.role = MASTER)` is false without a user row, as in SQL. */
  private visibleToCompany(activity: Activity): boolean {
    const author = this.author(activity);

    return (
      (author !== null && author.role !== "MASTER") ||
      activity.visibilityLevel === TENANT_VISIBLE
    );
  }

  private scope({
    currentUserRole,
    businessId,
    search,
    userId,
    periodDays,
    filters = {},
  }: {
    currentUserRole: string;
    businessId?: string | null;
    search?: string;
    userId?: string;
    periodDays?: number;
    filters?: ActivityListFilters;
  }): Activity[] {
    const viewer = userId ? this.users.get(userId) : undefined;
    const term = search?.trim() ?? "";

    let scopeBusinessId: string | null | undefined;
    let rows = [...this.activities];

    if (currentUserRole === "MASTER") {
      scopeBusinessId = businessId ?? null;

      if (businessId)
        rows = rows.filter((row) => row.businessId === businessId);
    } else if (currentUserRole === "BUSINESS_ADMIN") {
      scopeBusinessId = viewer?.businessId;

      rows = rows.filter(
        (row) =>
          row.businessId === (viewer?.businessId ?? "__none__") &&
          this.visibleToCompany(row),
      );
    } else if (currentUserRole === "BUSINESS_USER") {
      scopeBusinessId = viewer?.businessId;

      rows = rows.filter(
        (row) => row.performedBy === (userId && viewer ? userId : "__none__"),
      );
    } else {
      scopeBusinessId = businessId;

      rows = rows.filter(
        (row) =>
          (!businessId || row.businessId === businessId) &&
          this.visibleToCompany(row),
      );
    }

    if (term) {
      rows = rows.filter((row) => {
        const author = this.author(row);
        const businessName =
          currentUserRole === "MASTER" && row.businessId
            ? this.businesses.get(row.businessId)?.corporate_reason
            : undefined;

        // A platform row is not found by the operator's id or e-mail for a
        // company reader, as in the repository.
        const identityShown =
          currentUserRole === "MASTER" || author?.role !== "MASTER";

        return [
          row.id,
          row.type,
          row.action,
          row.entityId,
          row.description,
          row.status,
          identityShown ? row.performedBy : null,
          identityShown ? author?.email : null,
          businessName,
        ].some((value) => containsInsensitive(value, term));
      });
    }

    if (filters.statuses?.length) {
      const stored = new Set(storedStatusesFor(filters.statuses));

      rows = rows.filter((row) => stored.has(row.status));
    }

    if (filters.types?.length) {
      rows = rows.filter((row) =>
        (filters.types as string[]).includes(row.type),
      );
    }

    if (filters.actions?.length) {
      rows = rows.filter((row) =>
        (filters.actions as string[]).includes(row.action),
      );
    }

    if (filters.roles?.length) {
      rows = rows.filter((row) =>
        (filters.roles as string[]).some((role) => this.matchesRole(row, role)),
      );
    }

    if (periodDays) {
      const timeZone = scopeBusinessId
        ? resolveTimeZone(this.businesses.get(scopeBusinessId)?.timezone)
        : DEFAULT_BUSINESS_TIMEZONE;
      const { start } = businessDaysRange(new Date(), timeZone, periodDays);

      rows = rows.filter((row) => time(row.created_at) >= start.getTime());
    }

    return rows;
  }

  /** The joined shape the repository returns: `user` and, for a MASTER, `business`. */
  private joined(row: Activity, currentUserRole: string): ActivityRow {
    const author = this.author(row);

    return {
      ...row,
      user: author
        ? {
            email: author.email,
            role: author.role,
            name: author.name,
            driverId: author.driverId,
          }
        : null,
      ...(currentUserRole === "MASTER" && {
        business: row.businessId
          ? {
              corporate_reason:
                this.businesses.get(row.businessId)?.corporate_reason ?? "",
            }
          : null,
      }),
    };
  }

  async listRecentActivitiesPreview({
    take,
    currentUserRole,
    businessId,
    userId,
  }: ListRecentActivitiesPreviewProps): Promise<Activity[]> {
    const rows = this.scope({ currentUserRole, businessId, userId })
      .sort(
        (a, b) =>
          compareForOrder(
            new Date(a.created_at),
            new Date(b.created_at),
            "desc",
          ) || compareForOrder(a.id, b.id, "desc"),
      )
      .slice(0, take)
      .map((row) => this.joined(row, currentUserRole));

    return presentActivityActors(rows, currentUserRole);
  }

  async listAllActivities({
    page,
    pageSize,
    currentUserRole,
    businessId,
    search,
    userId,
    statuses,
    types,
    actions,
    roles,
    order = "desc",
  }: ListRecentActivitiesProps): Promise<ListActivityProps> {
    // orderBy [{ created_at: order }, { id: order }], as Postgres sorts it.
    const rows = this.scope({
      currentUserRole,
      businessId,
      search,
      userId,
      filters: { statuses, types, actions, roles },
    }).sort(
      (a, b) =>
        compareForOrder(
          new Date(a.created_at),
          new Date(b.created_at),
          order,
        ) || compareForOrder(a.id, b.id, order),
    );

    const start = (page - 1) * pageSize;

    return {
      data: presentActivityActors(
        rows
          .slice(start, start + pageSize)
          .map((row) => this.joined(row, currentUserRole)),
        currentUserRole,
      ),
      total: rows.length,
    };
  }

  /**
   * Same keyset walk as the Prisma repository: newest first, one row past the
   * page to decide whether there is more, and the cursor row excluded.
   */
  async listActivitiesWithCursor({
    currentUserRole,
    businessId,
    userId,
    limit,
    cursor,
    search,
    periodDays,
  }: ListActivitiesCursorProps): Promise<CursorPaginatedActivities> {
    const ordered = this.scope({
      currentUserRole,
      businessId,
      search,
      userId,
      periodDays,
    }).sort(byIdDesc);

    // Prisma positions on the cursor ROW (wherever it is) and skips one; an
    // unknown cursor used to restart the feed from the top here (index -1 + 1).
    const window = afterCursor(
      ordered,
      this.activities,
      cursor,
      byIdDesc,
    ).slice(0, limit + 1);

    const hasMore = window.length > limit;
    const data = hasMore ? window.slice(0, limit) : window;

    return {
      data: presentActivityActors(
        data.map((row) => this.joined(row, currentUserRole)),
        currentUserRole,
      ),
      nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  async summarizeActivities({
    currentUserRole,
    businessId,
    userId,
    periodDays,
  }: ActivitySummaryProps): Promise<ActivitySummary> {
    const scoped = this.scope({
      currentUserRole,
      businessId,
      userId,
      periodDays,
    });

    const countFor = (action: string): number =>
      scoped.filter((activity) => activity.action === action).length;

    const typeCounts = scoped.reduce<Record<string, number>>(
      (acc, activity) => {
        acc[activity.type] = (acc[activity.type] ?? 0) + 1;
        return acc;
      },
      {},
    );

    // Most frequent first; the name breaks a tie, as the GROUP BY orders it.
    const [topType, topTypeCount] = Object.entries(typeCounts).sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )[0] ?? [null, 0];

    return {
      total: scoped.length,
      created: countFor("create"),
      updated: countFor("update"),
      deleted: countFor("delete"),
      activeUsers: new Set(
        scoped
          .map((activity) => activity.performedBy)
          .filter((id): id is string => Boolean(id)),
      ).size,
      topType: topType as string | null,
      topTypeCount: topTypeCount as number,
      periodDays,
    };
  }
}

export { InMemoryActivityRepository };
