import database from "@/../infra/database";
import {
  DEFAULT_PAUSE_TYPE_KEY,
  ensureDefaultOccurrenceTypes,
} from "@/shared/delivery/default-occurrence-types";

import type { IDriverPauseRepository } from "./IDriver-pause-repository";
import { pauseConflictOf } from "./pause-conflicts";
import { dateOnlyFromKey, dateOnlyKey } from "@/shared/time/business-day";
import {
  journeyRouteAt,
  type JourneyRoute,
} from "../rules/pause-journey-rules";

import type {
  CloseDriverPauseData,
  CloseDriverPauseResult,
  CreateDriverPauseData,
  CreateDriverPauseResult,
  DriverPause,
  DriverPauseKind,
  PauseReportQuery,
  PauseReportRoute,
  PauseReportSource,
  PauseTypeInfo,
} from "../dtos/driver-pause-dto";

const PAUSE_TYPE_SELECT = {
  id: true,
  name: true,
  category: true,
  pause_kind: true,
  is_active: true,
} as const;

/** Route states in which a route has been on the street. */
const LEFT_STATUSES = ["IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;

class DriverPauseRepository implements IDriverPauseRepository {
  constructor(private prisma = database) {}

  async timeZoneOf(businessId: string): Promise<string | null> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { timezone: true },
    });

    return business?.timezone ?? null;
  }

  async findByStartSubmission(
    businessId: string,
    startSubmissionId: string,
  ): Promise<DriverPause | null> {
    return this.prisma.driverPause.findUnique({
      where: {
        businessId_start_submission_id: {
          businessId,
          start_submission_id: startSubmissionId,
        },
      },
    });
  }

  async findByEndSubmission(
    businessId: string,
    endSubmissionId: string,
  ): Promise<DriverPause | null> {
    return this.prisma.driverPause.findUnique({
      where: {
        businessId_end_submission_id: {
          businessId,
          end_submission_id: endSubmissionId,
        },
      },
    });
  }

  async findOpenPause(
    businessId: string,
    driverId: string,
  ): Promise<DriverPause | null> {
    return this.prisma.driverPause.findFirst({
      where: { businessId, driverId, ended_at: null },
    });
  }

  async findRouteRunningAt(
    businessId: string,
    driverId: string,
    at: Date,
  ): Promise<string | null> {
    // A cancelled route has no completed_at: it left the street when it was
    // cancelled, which is its updated_at (the tower reads it the same way).
    const route = await this.prisma.route.findFirst({
      where: {
        businessId,
        driverId,
        started_at: { lte: at },
        OR: [
          { status: "IN_PROGRESS" },
          { status: "COMPLETED", completed_at: { gte: at } },
          { status: "CANCELLED", updated_at: { gte: at } },
        ],
      },
      orderBy: [{ started_at: "desc" }, { id: "desc" }],
      select: { id: true },
    });

    return route?.id ?? null;
  }

  async findJourneyRouteAt(
    businessId: string,
    driverId: string,
    at: Date,
    dayKey: string,
  ): Promise<string | null> {
    // The candidates by index (businessId, driverId, status), narrowed to
    // routes not finished at `at` and of that day or already started; the
    // pure rule then decides, the same one the twin runs.
    const rows = await this.prisma.route.findMany({
      where: {
        businessId,
        driverId,
        OR: [
          { status: { in: ["RELEASED", "IN_PROGRESS"] } },
          { status: "COMPLETED", completed_at: { gte: at } },
          { status: "COMPLETED", completed_at: null, updated_at: { gte: at } },
          { status: "CANCELLED", updated_at: { gte: at } },
        ],
        AND: [
          {
            OR: [
              { scheduled_date: dateOnlyFromKey(dayKey) },
              { started_at: { lte: at } },
            ],
          },
        ],
      },
      select: {
        id: true,
        status: true,
        released_at: true,
        started_at: true,
        completed_at: true,
        updated_at: true,
        scheduled_date: true,
      },
    });

    const routes: JourneyRoute[] = rows.map((row) => ({
      ...row,
      scheduled_date: dateOnlyKey(row.scheduled_date),
    }));

    return journeyRouteAt(routes, at, dayKey)?.id ?? null;
  }

  async findPauseType(
    businessId: string,
    occurrenceTypeId: string,
  ): Promise<PauseTypeInfo | null> {
    return this.prisma.occurrenceType.findFirst({
      where: { id: occurrenceTypeId, businessId },
      select: PAUSE_TYPE_SELECT,
    });
  }

  async defaultPauseType(
    businessId: string,
    kind: DriverPauseKind,
  ): Promise<PauseTypeInfo> {
    const id = await this.defaultPauseTypeId(businessId, kind);

    return this.prisma.occurrenceType.findUniqueOrThrow({
      where: { id },
      select: PAUSE_TYPE_SELECT,
    });
  }

  async pauseTypeNames(
    businessId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();

    const rows = await this.prisma.occurrenceType.findMany({
      where: { businessId, id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });

    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /**
   * The company's seeded PAUSE type of this nature (decision 14.4), for a
   * caller that names only `kind` (the installed app's body). Seeds the
   * defaults first when the company has none yet (one created after the
   * migration and before create-business seeded them).
   */
  private async defaultPauseTypeId(
    businessId: string,
    kind: DriverPauseKind,
  ): Promise<string> {
    const where = {
      businessId_system_key: {
        businessId,
        system_key: DEFAULT_PAUSE_TYPE_KEY[kind],
      },
    };

    const found = await this.prisma.occurrenceType.findUnique({
      where,
      select: { id: true },
    });
    if (found) return found.id;

    await ensureDefaultOccurrenceTypes(this.prisma, businessId);

    const seeded = await this.prisma.occurrenceType.findUniqueOrThrow({
      where,
      select: { id: true },
    });

    return seeded.id;
  }

  /** The given type, only if it is this company's PAUSE type of this kind. */
  private async ownPauseTypeId(
    businessId: string,
    kind: DriverPauseKind,
    occurrenceTypeId: string,
  ): Promise<string | null> {
    const type = await this.prisma.occurrenceType.findFirst({
      where: {
        id: occurrenceTypeId,
        businessId,
        category: "PAUSE",
        pause_kind: kind,
      },
      select: { id: true },
    });

    return type?.id ?? null;
  }

  async createPause(
    data: CreateDriverPauseData,
  ): Promise<CreateDriverPauseResult> {
    // The FK accepts any tenant's type: the tenant, category and nature are
    // checked here, before the insert.
    const occurrenceTypeId = data.occurrenceTypeId
      ? await this.ownPauseTypeId(
          data.businessId,
          data.kind,
          data.occurrenceTypeId,
        )
      : await this.defaultPauseTypeId(data.businessId, data.kind);

    if (!occurrenceTypeId) return { status: "invalid-type" };

    try {
      const pause = await this.prisma.driverPause.create({
        data: {
          occurrenceTypeId,
          kind: data.kind,
          started_at: data.started_at,
          ended_at: data.ended_at ?? null,
          start_latitude: data.start_latitude ?? null,
          start_longitude: data.start_longitude ?? null,
          end_latitude: data.end_latitude ?? null,
          end_longitude: data.end_longitude ?? null,
          note: data.note ?? null,
          start_submission_id: data.start_submission_id,
          end_submission_id: data.end_submission_id ?? null,
          driverId: data.driverId,
          businessId: data.businessId,
          routeId: data.routeId ?? null,
        },
      });

      return { status: "created", pause };
    } catch (error) {
      // The indexes decide, not a read before the insert: two replicas
      // handling the same resend, or two taps, race past any such read.
      const conflict = pauseConflictOf(error);

      if (conflict) return { status: conflict };

      throw error;
    }
  }

  async closePause(
    data: CloseDriverPauseData,
  ): Promise<CloseDriverPauseResult> {
    try {
      // Conditional on still being open: a concurrent end waits for the row
      // lock, then finds ended_at set and writes nothing.
      const moved = await this.prisma.driverPause.updateMany({
        where: {
          id: data.pauseId,
          businessId: data.businessId,
          ended_at: null,
        },
        data: {
          ended_at: data.ended_at,
          end_submission_id: data.end_submission_id,
          end_latitude: data.end_latitude ?? null,
          end_longitude: data.end_longitude ?? null,
        },
      });

      if (moved.count === 0) return { status: "not-open" };

      const pause = await this.prisma.driverPause.findUniqueOrThrow({
        where: { id: data.pauseId },
      });

      return { status: "closed", pause };
    } catch (error) {
      if (pauseConflictOf(error) === "end-submission-taken") {
        return { status: "end-submission-taken" };
      }

      throw error;
    }
  }

  async listDriverPauses(
    businessId: string,
    driverId: string,
    range: { start: Date; end: Date },
  ): Promise<DriverPause[]> {
    return this.prisma.driverPause.findMany({
      where: {
        businessId,
        driverId,
        started_at: { gte: range.start, lt: range.end },
      },
      orderBy: [{ started_at: "asc" }, { id: "asc" }],
    });
  }

  async loadReportSource({
    businessId,
    extraDriverNames,
    start,
    end,
  }: PauseReportQuery): Promise<PauseReportSource> {
    // Sequential on purpose: one connection per request (the screen budget).
    const pauses = await this.prisma.driverPause.findMany({
      where: { businessId, started_at: { gte: start, lt: end } },
      select: {
        id: true,
        kind: true,
        started_at: true,
        ended_at: true,
        note: true,
        routeId: true,
        driverId: true,
        start_submission_id: true,
        end_submission_id: true,
        occurrenceType: { select: { name: true } },
      },
      orderBy: [{ started_at: "asc" }, { id: "asc" }],
    });

    const routeRows = await this.prisma.route.findMany({
      where: {
        businessId,
        status: { in: [...LEFT_STATUSES] },
        started_at: { gte: start, lt: end },
      },
      select: {
        id: true,
        driverId: true,
        status: true,
        started_at: true,
        completed_at: true,
        updated_at: true,
      },
      orderBy: [{ started_at: "asc" }, { id: "asc" }],
    });

    const routes: PauseReportRoute[] = routeRows.map((route) => ({
      id: route.id,
      driverId: route.driverId,
      status: route.status as PauseReportRoute["status"],
      started_at: route.started_at as Date,
      ended_at:
        route.status === "IN_PROGRESS"
          ? null
          : route.status === "CANCELLED"
            ? route.updated_at
            : (route.completed_at ?? route.updated_at),
    }));

    const wanted = new Set<string>([
      ...(extraDriverNames ?? []),
      ...pauses.map((pause) => pause.driverId),
      ...routes.map((route) => route.driverId),
    ]);

    // The tenant in the where: an id of another company named in the filter
    // brings back no name.
    const drivers =
      wanted.size === 0
        ? []
        : await this.prisma.driver.findMany({
            where: { businessId, id: { in: [...wanted] } },
            select: { id: true, name: true },
          });

    return {
      pauses: pauses.map(({ occurrenceType, ...pause }) => ({
        ...pause,
        occurrence_type_name: occurrenceType.name,
      })),
      routes,
      drivers,
    };
  }
}

export { DriverPauseRepository };
