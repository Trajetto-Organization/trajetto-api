import { randomUUID } from "node:crypto";

import type { OccurrenceCategory } from "@prisma/client";

import {
  DEFAULT_OCCURRENCE_TYPES,
  DEFAULT_PAUSE_TYPE_KEY,
} from "@/shared/delivery/default-occurrence-types";
import { compareForOrder } from "@/shared/pagination/in-memory-order";

import type { IDriverPauseRepository } from "../IDriver-pause-repository";
import { journeyRouteAt } from "../../rules/pause-journey-rules";

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
} from "../../dtos/driver-pause-dto";

/** What this twin mirrors of a route row. */
interface RouteMirror {
  id: string;
  businessId: string;
  driverId: string;
  status: "PLANNED" | "RELEASED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
  /** Decision 14.4; absent = null (a route released before the column). */
  released_at?: Date | null;
  /** "YYYY-MM-DD"; absent = a day no business day matches. */
  scheduled_date?: string;
}

interface DriverMirror {
  id: string;
  businessId: string;
  name: string;
}

interface BusinessMirror {
  id: string;
  timezone: string;
}

/** What this twin mirrors of an occurrence_type row. */
interface PauseTypeMirror {
  id: string;
  businessId: string;
  category: OccurrenceCategory;
  pause_kind: DriverPauseKind | null;
  system_key: string | null;
  /** Absent = the seed's name, or "Tipo". */
  name?: string;
  /** Absent = active. */
  is_active?: boolean;
}

const byStart = (a: DriverPause | PauseReportRoute, b: DriverPause | PauseReportRoute) =>
  compareForOrder(a.started_at, b.started_at, "asc") ||
  compareForOrder(a.id, b.id, "asc");

/**
 * The in-memory twin of DriverPauseRepository (decision 13.2): the same
 * filters, order and unique indexes, checked in the order Postgres checks
 * them (index creation order: start key, end key, then the partial
 * one-open-pause index).
 */
class InMemoryDriverPauseRepository implements IDriverPauseRepository {
  constructor(
    public pauses: DriverPause[] = [],
    public routes: RouteMirror[] = [],
    public drivers: DriverMirror[] = [],
    public businesses: BusinessMirror[] = [],
    public occurrenceTypes: PauseTypeMirror[] = [],
  ) {}

  /**
   * The seeded type of the nature, seeding the four defaults first when the
   * company has none, as ensureDefaultOccurrenceTypes does. A company that
   * does not exist gets nothing, and the lookup then throws, as Prisma's
   * findUniqueOrThrow does.
   */
  private defaultPauseTypeId(businessId: string, kind: DriverPauseKind): string {
    const key = DEFAULT_PAUSE_TYPE_KEY[kind];
    const find = () =>
      this.occurrenceTypes.find(
        (type) => type.businessId === businessId && type.system_key === key,
      );

    const found = find();
    if (found) return found.id;

    if (this.businesses.some((business) => business.id === businessId)) {
      for (const seed of DEFAULT_OCCURRENCE_TYPES) {
        const taken = this.occurrenceTypes.some(
          (type) => type.businessId === businessId && type.system_key === seed.system_key,
        );

        if (!taken) {
          this.occurrenceTypes.push({
            id: randomUUID(),
            businessId,
            category: seed.category,
            pause_kind: seed.pause_kind,
            system_key: seed.system_key,
            name: seed.name,
            is_active: true,
          });
        }
      }
    }

    const seeded = find();
    if (!seeded) throw new Error(`No occurrence type ${key} for company ${businessId}`);

    return seeded.id;
  }

  async timeZoneOf(businessId: string): Promise<string | null> {
    return this.businesses.find((business) => business.id === businessId)?.timezone ?? null;
  }

  async findByStartSubmission(
    businessId: string,
    startSubmissionId: string,
  ): Promise<DriverPause | null> {
    return (
      this.pauses.find(
        (pause) =>
          pause.businessId === businessId &&
          pause.start_submission_id === startSubmissionId,
      ) ?? null
    );
  }

  async findByEndSubmission(
    businessId: string,
    endSubmissionId: string,
  ): Promise<DriverPause | null> {
    return (
      this.pauses.find(
        (pause) =>
          pause.businessId === businessId &&
          pause.end_submission_id === endSubmissionId,
      ) ?? null
    );
  }

  async findOpenPause(
    businessId: string,
    driverId: string,
  ): Promise<DriverPause | null> {
    return (
      this.pauses.find(
        (pause) =>
          pause.businessId === businessId &&
          pause.driverId === driverId &&
          pause.ended_at === null,
      ) ?? null
    );
  }

  async findRouteRunningAt(
    businessId: string,
    driverId: string,
    at: Date,
  ): Promise<string | null> {
    const time = at.getTime();

    const running = this.routes
      .filter(
        (route) =>
          route.businessId === businessId &&
          route.driverId === driverId &&
          route.started_at !== null &&
          route.started_at.getTime() <= time &&
          (route.status === "IN_PROGRESS" ||
            (route.status === "COMPLETED" &&
              route.completed_at !== null &&
              route.completed_at.getTime() >= time) ||
            (route.status === "CANCELLED" && route.updated_at.getTime() >= time)),
      )
      .sort(
        (a, b) =>
          compareForOrder(a.started_at, b.started_at, "desc") ||
          compareForOrder(a.id, b.id, "desc"),
      );

    return running[0]?.id ?? null;
  }

  async findJourneyRouteAt(
    businessId: string,
    driverId: string,
    at: Date,
    dayKey: string,
  ): Promise<string | null> {
    const routes = this.routes
      .filter((route) => route.businessId === businessId && route.driverId === driverId)
      .map((route) => ({
        ...route,
        released_at: route.released_at ?? null,
        scheduled_date: route.scheduled_date ?? "",
      }));

    return journeyRouteAt(routes, at, dayKey)?.id ?? null;
  }

  private infoOf(type: PauseTypeMirror): PauseTypeInfo {
    return {
      id: type.id,
      name: type.name ?? "Tipo",
      category: type.category,
      pause_kind: type.pause_kind,
      is_active: type.is_active !== false,
    };
  }

  async findPauseType(
    businessId: string,
    occurrenceTypeId: string,
  ): Promise<PauseTypeInfo | null> {
    const type = this.occurrenceTypes.find(
      (entry) => entry.id === occurrenceTypeId && entry.businessId === businessId,
    );

    return type ? this.infoOf(type) : null;
  }

  async defaultPauseType(businessId: string, kind: DriverPauseKind): Promise<PauseTypeInfo> {
    const id = this.defaultPauseTypeId(businessId, kind);

    return this.infoOf(this.occurrenceTypes.find((type) => type.id === id)!);
  }

  async pauseTypeNames(businessId: string, ids: string[]): Promise<Map<string, string>> {
    return new Map(
      this.occurrenceTypes
        .filter((type) => type.businessId === businessId && ids.includes(type.id))
        .map((type) => [type.id, type.name ?? "Tipo"]),
    );
  }

  async createPause(data: CreateDriverPauseData): Promise<CreateDriverPauseResult> {
    // Resolved before the unique checks, as the Prisma repository does.
    const occurrenceTypeId = data.occurrenceTypeId
      ? (this.occurrenceTypes.find(
          (type) =>
            type.id === data.occurrenceTypeId &&
            type.businessId === data.businessId &&
            type.category === "PAUSE" &&
            type.pause_kind === data.kind,
        )?.id ?? null)
      : this.defaultPauseTypeId(data.businessId, data.kind);

    if (!occurrenceTypeId) return { status: "invalid-type" };

    const sameCompany = this.pauses.filter(
      (pause) => pause.businessId === data.businessId,
    );

    if (sameCompany.some((pause) => pause.start_submission_id === data.start_submission_id)) {
      return { status: "start-submission-taken" };
    }

    // A NULL never collides in a unique index.
    if (
      data.end_submission_id &&
      sameCompany.some((pause) => pause.end_submission_id === data.end_submission_id)
    ) {
      return { status: "end-submission-taken" };
    }

    // The partial index is on driverId alone, across companies.
    if (
      !data.ended_at &&
      this.pauses.some((pause) => pause.driverId === data.driverId && pause.ended_at === null)
    ) {
      return { status: "already-open" };
    }

    const now = new Date();

    const pause: DriverPause = {
      id: randomUUID(),
      kind: data.kind,
      occurrenceTypeId,
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
      created_at: now,
      updated_at: now,
    };

    this.pauses.push(pause);

    return { status: "created", pause: { ...pause } };
  }

  async closePause(data: CloseDriverPauseData): Promise<CloseDriverPauseResult> {
    const index = this.pauses.findIndex(
      (pause) =>
        pause.id === data.pauseId &&
        pause.businessId === data.businessId &&
        pause.ended_at === null,
    );

    if (index === -1) return { status: "not-open" };

    if (
      this.pauses.some(
        (pause) =>
          pause.businessId === data.businessId &&
          pause.end_submission_id === data.end_submission_id,
      )
    ) {
      return { status: "end-submission-taken" };
    }

    const closed: DriverPause = {
      ...this.pauses[index],
      ended_at: data.ended_at,
      end_submission_id: data.end_submission_id,
      end_latitude: data.end_latitude ?? null,
      end_longitude: data.end_longitude ?? null,
      updated_at: new Date(),
    };

    this.pauses[index] = closed;

    return { status: "closed", pause: { ...closed } };
  }

  async listDriverPauses(
    businessId: string,
    driverId: string,
    range: { start: Date; end: Date },
  ): Promise<DriverPause[]> {
    return this.pauses
      .filter(
        (pause) =>
          pause.businessId === businessId &&
          pause.driverId === driverId &&
          pause.started_at >= range.start &&
          pause.started_at < range.end,
      )
      .sort(byStart)
      .map((pause) => ({ ...pause }));
  }

  async loadReportSource({
    businessId,
    extraDriverNames,
    start,
    end,
  }: PauseReportQuery): Promise<PauseReportSource> {
    const pauses = this.pauses
      .filter(
        (pause) =>
          pause.businessId === businessId &&
          pause.started_at >= start &&
          pause.started_at < end,
      )
      .sort(byStart)
      .map((pause) => ({
        id: pause.id,
        kind: pause.kind,
        started_at: pause.started_at,
        ended_at: pause.ended_at,
        note: pause.note,
        routeId: pause.routeId,
        driverId: pause.driverId,
        start_submission_id: pause.start_submission_id,
        end_submission_id: pause.end_submission_id,
        occurrence_type_name:
          this.occurrenceTypes.find((type) => type.id === pause.occurrenceTypeId)?.name ??
          "Tipo",
      }));

    const routes: PauseReportRoute[] = this.routes
      .filter(
        (route): route is RouteMirror & { started_at: Date } =>
          route.businessId === businessId &&
          (route.status === "IN_PROGRESS" ||
            route.status === "COMPLETED" ||
            route.status === "CANCELLED") &&
          route.started_at !== null &&
          route.started_at >= start &&
          route.started_at < end,
      )
      .map((route) => ({
        id: route.id,
        driverId: route.driverId,
        status: route.status as PauseReportRoute["status"],
        started_at: route.started_at,
        ended_at:
          route.status === "IN_PROGRESS"
            ? null
            : route.status === "CANCELLED"
              ? route.updated_at
              : (route.completed_at ?? route.updated_at),
      }))
      .sort(byStart);

    const wanted = new Set<string>([
      ...(extraDriverNames ?? []),
      ...pauses.map((pause) => pause.driverId),
      ...routes.map((route) => route.driverId),
    ]);

    const drivers = this.drivers
      .filter((driver) => driver.businessId === businessId && wanted.has(driver.id))
      .map((driver) => ({ id: driver.id, name: driver.name }));

    return { pauses, routes, drivers };
  }
}

export { InMemoryDriverPauseRepository };
export type { BusinessMirror, DriverMirror, PauseTypeMirror, RouteMirror };
