import { Prisma } from "@prisma/client";

import database, { readDatabase } from "@/../infra/database";
import {
  ActivitySummary,
  ActivitySummaryProps,
  Activity,
  ActivityListFilters,
  CreateActivityProps,
  CursorPaginatedActivities,
  ListActivitiesCursorProps,
  ListActivityProps,
  ListRecentActivitiesProps,
  ListRecentActivitiesPreviewProps,
} from "../dtos/activity-dto";

import { presentActivityActors } from "@/shared/activity/actor-presentation";
import {
  activityCountTake,
  activityIdRange,
  cappedActivityTotal,
} from "@/shared/activity/activity-period";
import {
  activityDataVersion,
  type ActivityDataVersion,
} from "@/shared/activity/activity-data-version";

import { IActivityRepository } from "./IActivity-repository";
import { TENANT_VISIBLE } from "@/shared/notifications/policies/business-plan-policies";

import { buildSearchOr } from "@/shared/pagination/search-or";
import {
  businessDaysRange,
  DEFAULT_BUSINESS_TIMEZONE,
  resolveTimeZone,
} from "@/shared/time/business-day";

import { canonicalStatus, storedStatusesFor } from "../activity-catalog";

/** What every listing reads of the author; `driverId` only to present it. */
const ACTOR_SELECT = {
  email: true,
  role: true,
  name: true,
  driverId: true,
} as const;

/** One author role, as the reader sees it, in terms of the user row. */
function roleCondition(role: string): Prisma.ActivityWhereInput {
  switch (role) {
    case "MASTER":
    case "PLATFORM":
      return { user: { role: "MASTER" } };
    case "BUSINESS_ADMIN":
      return { user: { role: "BUSINESS_ADMIN" } };
    case "DRIVER":
      // The same test the presentation makes: an admin linked to a driver
      // is still shown (and filtered) as an admin, never under both.
      return { user: { role: "BUSINESS_USER", driverId: { not: null } } };
    default:
      // BUSINESS_USER: a collaborator, not a driver acting from the app.
      return { user: { role: "BUSINESS_USER", driverId: null } };
  }
}

/** The server-side facets of the table (decision 8.8, FLEET-ACT-3). */
function facetConditions(
  filters: ActivityListFilters,
): Prisma.ActivityWhereInput[] {
  const and: Prisma.ActivityWhereInput[] = [];

  if (filters.statuses?.length) {
    and.push({ status: { in: storedStatusesFor(filters.statuses) } });
  }

  if (filters.types?.length) and.push({ type: { in: filters.types } });
  if (filters.actions?.length) and.push({ action: { in: filters.actions } });

  if (filters.roles?.length) {
    and.push({ OR: filters.roles.map(roleCondition) });
  }

  return and;
}

class ActivityRepository implements IActivityRepository {
  constructor(private prisma = database) {}

  /**
   * The heavy reads' bulkhead (plano-escala F3-17), for the activities' lists
   * and summary (the scope they filter by is still read on the primary: it is
   * who may see what): a pool of its own, 3 connections and 10 s a statement,
   * so a burst of them waits among itself instead of taking the connections
   * every other request needs. A repository built on another client (a test's)
   * reads on that client. A getter, so a module that mocks infra/database
   * without it only needs it when one of these reads runs.
   * With DATABASE_REPLICA_URL, readDatabase() sends them to the standby
   * while the replica guard vouches for it: lists only (plano-escala F4-42,
   * tests/unitaires/database/read-routing-guard.test.ts).
   */
  private get read(): typeof this.prisma {
    return this.prisma === database ? readDatabase() : this.prisma;
  }

  async createActivity(
    activityData: CreateActivityProps,
    tx?: Prisma.TransactionClient,
  ): Promise<Activity> {
    // Inside the caller's transaction when it passes one, so the entry and
    // the write it describes commit together (OUTBOX-10).
    const client = tx ?? this.prisma;

    let tenantName: string | null = activityData.tenantName ?? null;

    if (!tenantName && activityData.businessId) {
      const business = await client.business.findUnique({
        where: { id: activityData.businessId },
        select: { corporate_reason: true },
      });

      tenantName = business?.corporate_reason ?? null;
    }

    // One spelling per status (FLEET-ACT-1/5): a raw enum ("PLANNED") or a
    // variant ("Em Rota") becomes the catalog's label, so no writer can put
    // a badge on screen that the filter and the badge map do not know.
    const data = {
      ...activityData,
      status: canonicalStatus(activityData.status),
      tenantName,
    };

    /**
     * A write coming from the notification pipeline is idempotent by its
     * delivery id, which is also the row's own id (plano-escala F2-15).
     *
     * The activity trail becomes a table partitioned by month on its id
     * (F2-18, wave 11), and there the global unique on `deliveryId` cannot
     * stay: the primary key becomes the anchor, so a redelivery of the same
     * notification_delivery (a uuid v7, minted when the event expanded)
     * writes the same id. Until then both indexes hold, and the row the
     * previous image wrote under a random id is still found by `deliveryId`:
     * first by id, then by deliveryId (the fallback goes after the copy
     * window, U-10), and only then the insert.
     *
     * An activity that already exists is left exactly as it was recorded
     * the first time, timestamps included. Two workers recording the same
     * delivery at once both pass the reads (measured in
     * tests/E2E/repository-guards.test.ts); the loser's P2002, on either
     * index, means the row it wanted to write is there, so it is read and
     * returned instead of failing the delivery into a retry.
     */
    if (activityData.deliveryId) {
      const deliveryId = activityData.deliveryId;
      const recorded = () => this.findPipelineActivity(deliveryId);

      const existing = await recorded();
      if (existing) return existing;

      try {
        return await this.prisma.activity.create({
          data: { ...data, id: deliveryId },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const winner = await recorded();

          if (winner) return winner;
        }

        throw error;
      }
    }

    const activity = await client.activity.create({ data });

    return activity;
  }

  /**
   * The row the pipeline recorded for a notification_delivery: under its
   * id (F2-15), or under the random id the previous image gave it.
   */
  private async findPipelineActivity(
    deliveryId: string,
  ): Promise<Activity | null> {
    return (
      (await this.prisma.activity.findUnique({ where: { id: deliveryId } })) ??
      (await this.prisma.activity.findFirst({ where: { deliveryId } }))
    );
  }

  /**
   * Who may see which activities, in one place.
   *
   * The listings, the cursor feed and the summary are built from the same
   * rules, and the rules are subtle enough — a company admin sees the company
   * except MASTER actions, unless the action is its own plan changing — that
   * separate copies would drift the way the navigation gates did (the
   * summary's copy already had: the MASTER's company filter applied to the
   * cards but not to the table).
   */
  private async buildActivityScope({
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
  }): Promise<Prisma.ActivityWhereInput> {
    const term = search?.trim() ?? "";

    const currentUser = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, businessId: true },
        })
      : null;

    const and: Prisma.ActivityWhereInput[] = [];

    if (term) {
      and.push(
        buildSearchOr<Prisma.ActivityWhereInput>([
          { id: { contains: term, mode: "insensitive" } },
          { type: { contains: term, mode: "insensitive" } },
          { action: { contains: term, mode: "insensitive" } },
          { entityId: { contains: term, mode: "insensitive" } },
          { description: { contains: term, mode: "insensitive" } },
          { status: { contains: term, mode: "insensitive" } },
          // The author's id and e-mail are searchable only where they are
          // shown: a company reader sees a platform row as "Suporte
          // Trajetto", so matching it by the operator's e-mail would confirm
          // a guess the presentation hides (actor-presentation).
          currentUserRole === "MASTER"
            ? { performedBy: { contains: term, mode: "insensitive" } }
            : {
                performedBy: { contains: term, mode: "insensitive" },
                NOT: { user: { role: "MASTER" } },
              },
          currentUserRole === "MASTER"
            ? { user: { email: { contains: term, mode: "insensitive" } } }
            : {
                user: {
                  email: { contains: term, mode: "insensitive" },
                  NOT: { role: "MASTER" },
                },
              },
          ...(currentUserRole === "MASTER"
            ? [
                {
                  business: {
                    corporate_reason: { contains: term, mode: "insensitive" },
                  },
                } as Prisma.ActivityWhereInput,
              ]
            : []),
        ]),
      );
    }

    // Hierarchical visibility, by role.
    let scopeBusinessId: string | null | undefined;

    if (currentUserRole === "MASTER") {
      // Everything, or one company when the MASTER names it.
      scopeBusinessId = businessId ?? null;

      if (businessId) and.push({ businessId });
    } else if (currentUserRole === "BUSINESS_ADMIN") {
      // The company, minus MASTER actions — except the company's own plan
      // changing, whose absence turned "the menu disappeared" into a ticket.
      scopeBusinessId = currentUser?.businessId;

      and.push(
        { businessId: currentUser?.businessId ?? "__none__" },
        {
          OR: [
            { user: { NOT: { role: "MASTER" } } },
            { visibilityLevel: TENANT_VISIBLE },
          ],
        },
      );
    } else if (currentUserRole === "BUSINESS_USER") {
      // A collaborator sees only their own trail.
      scopeBusinessId = currentUser?.businessId;

      and.push({ performedBy: currentUser?.id ?? "__none__" });
    } else {
      scopeBusinessId = businessId;

      and.push(...(businessId ? [{ businessId }] : []), {
        OR: [
          { user: { NOT: { role: "MASTER" } } },
          { visibilityLevel: TENANT_VISIBLE },
        ],
      });
    }

    and.push(...facetConditions(filters));

    // The period is a window of CIVIL days in the company's zone (decision
    // 1.1): "7 dias" is today and the six days before it on the company's
    // clock, the same slice the cards and the feed describe.
    if (periodDays) {
      const timeZone = await this.timeZoneOf(scopeBusinessId);
      const { start } = businessDaysRange(new Date(), timeZone, periodDays);

      and.push({ created_at: { gte: start } });

      // The same period as ids (plano-escala F2-19): with the trail
      // partitioned by month on its id, it reads the months it is in.
      const ids = activityIdRange(start);

      if (ids) and.push({ id: ids });
    }

    return and.length > 0 ? { AND: and } : {};
  }

  /** The company's zone; the platform default without one. */
  private async timeZoneOf(
    businessId: string | null | undefined,
  ): Promise<string> {
    if (!businessId) return DEFAULT_BUSINESS_TIMEZONE;

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { timezone: true },
    });

    return resolveTimeZone(business?.timezone);
  }

  private includeFor(currentUserRole: string) {
    return {
      user: { select: ACTOR_SELECT },
      ...(currentUserRole === "MASTER" && {
        business: { select: { corporate_reason: true } },
      }),
    };
  }

  /**
   * The newest rows of the caller's scope, without the COUNT.
   *
   * The paginated listing counts the whole scope next to every page, which is
   * what a pager needs. The dashboard shows five lines and no pager, and the
   * activity trail has no retention by default: its count grew with the
   * company's entire history (the whole table for a MASTER) on the screen
   * every session lands on, only to be thrown away. With ORDER BY created_at
   * and a LIMIT, this is a short backward walk of (businessId, created_at),
   * or of (created_at) for a MASTER.
   */
  async listRecentActivitiesPreview({
    take,
    currentUserRole,
    businessId,
    userId,
  }: ListRecentActivitiesPreviewProps): Promise<Activity[]> {
    const whereCondition = await this.buildActivityScope({
      currentUserRole,
      businessId,
      userId,
    });

    const activities = await this.prisma.activity.findMany({
      take,
      where: whereCondition,
      include: this.includeFor(currentUserRole),
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
    });

    return presentActivityActors(activities, currentUserRole);
  }

  /**
   * The table: one page of the scope with the server-side facets (status,
   * type, action, author role) and the order on `created_at`, the one column
   * the indexes can order (decision 8.8). The id breaks ties so OFFSET paging
   * neither repeats nor skips rows written in the same millisecond.
   */
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
    periodDays,
  }: ListRecentActivitiesProps): Promise<ListActivityProps> {
    const whereCondition = await this.buildActivityScope({
      currentUserRole,
      businessId,
      search,
      userId,
      periodDays,
      filters: { statuses, types, actions, roles },
    });

    // The count stops one row past ACTIVITY_COUNT_CAP (F2-19): the pager
    // cannot go deeper, and the rest reads "10.000+".
    const [activities, counted] = await Promise.all([
      this.read.activity.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        where: whereCondition,
        include: this.includeFor(currentUserRole),
        orderBy: [{ created_at: order }, { id: order }],
      }),
      this.read.activity.count({
        where: whereCondition,
        take: activityCountTake(),
      }),
    ]);

    const { total, totalCapped } = cappedActivityTotal(counted);

    return {
      data: presentActivityActors(activities, currentUserRole),
      total,
      meta: { totalCapped, periodDays: periodDays ?? null },
    };
  }

  /**
   * The timeline feed, paginated by keyset rather than by offset.
   *
   * The table below it keeps page numbers, and rightly so — it has a total
   * and column filters. A feed is different: the audit log is written to
   * constantly, so by the time someone asks for "page 2" everything has
   * shifted down and rows already seen come back as duplicates. A cursor is
   * immune to that: it asks for what comes *after a row*, not for a position.
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
    const whereCondition = await this.buildActivityScope({
      currentUserRole,
      businessId,
      search,
      userId,
      periodDays,
    });

    // One row past the page: its existence is the only reliable way to know
    // whether a "load more" button should be there at all.
    const activities = await this.read.activity.findMany({
      where: whereCondition,
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      include: this.includeFor(currentUserRole),
      // uuid v7 ids are time-ordered, so this is creation order with a unique
      // tiebreaker — two activities written in the same millisecond still have
      // a defined position, which is what keeps the cursor from skipping rows.
      orderBy: { id: "desc" },
    });

    const hasMore = activities.length > limit;
    const data = hasMore ? activities.slice(0, limit) : activities;

    return {
      data: presentActivityActors(data, currentUserRole),
      nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  /**
   * Aggregates over the whole period, never over a page: the cards answer
   * "is anything odd going on?", which a page-scoped count cannot.
   *
   * Same scope as the listing (one builder). At most two queries at a time
   * (connection-fan-out budget): the total is the sum of the per-action
   * breakdown, not a separate COUNT.
   */
  async summarizeActivities({
    currentUserRole,
    businessId,
    userId,
    periodDays,
  }: ActivitySummaryProps): Promise<ActivitySummary> {
    const whereCondition = await this.buildActivityScope({
      currentUserRole,
      businessId,
      userId,
      periodDays,
    });

    const [byAction, byType] = await Promise.all([
      this.read.activity.groupBy({
        by: ["action"],
        where: whereCondition,
        _count: { _all: true },
      }),
      this.read.activity.groupBy({
        by: ["type"],
        where: whereCondition,
        _count: { _all: true },
        orderBy: [{ _count: { type: "desc" } }, { type: "asc" }],
        take: 1,
      }),
    ]);

    // System actions (no author) are not a person working.
    const authors = await this.read.activity.groupBy({
      by: ["performedBy"],
      where: { AND: [whereCondition, { performedBy: { not: null } }] },
    });

    const countFor = (action: string): number =>
      byAction.find((row) => row.action === action)?._count._all ?? 0;

    return {
      total: byAction.reduce((sum, row) => sum + row._count._all, 0),
      created: countFor("create"),
      updated: countFor("update"),
      deleted: countFor("delete"),
      activeUsers: authors.length,
      topType: byType[0]?.type ?? null,
      topTypeCount: byType[0]?._count._all ?? 0,
      periodDays,
    };
  }

  /**
   * The generation of ids the trail serves, from the catalog: the copy
   * window is what made activity a partitioned table and what re-keyed its
   * old ids (plano-escala F2-18). One lookup of pg_class by name.
   */
  async dataVersion(): Promise<ActivityDataVersion> {
    const [row] = await this.prisma.$queryRaw<Array<{ partitioned: boolean }>>`
      SELECT coalesce(
        (SELECT c.relkind = 'p' FROM pg_class c WHERE c.oid = to_regclass('activity')),
        false
      ) AS partitioned
    `;

    return activityDataVersion(row?.partitioned === true);
  }
}

export { ActivityRepository };
