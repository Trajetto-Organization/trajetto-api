import type { Prisma } from "@prisma/client";

import type { CustomerNoticeSource } from "@/shared/delivery/customer-notice";

/**
 * The stop a driver asked to mark, with what the use case decides on: its
 * route (whose driver, running or not) and its delivery (who to tell).
 */
interface OnTheWayTarget {
  stop: {
    id: string;
    routeId: string;
    deliveryId: string;
    status: string;
    on_the_way_at: Date | null;
  };

  route: {
    id: string;
    code: number;
    businessId: string;
    driverId: string;
    status: string;
    started_at: Date | null;
  };

  delivery: CustomerNoticeSource & { id: string };
}

/** The same stop and route, re-read under the route's row lock. */
interface LockedOnTheWayState {
  routeStatus: string;
  driverId: string;
  stopStatus: string;
  deliveryId: string;
  on_the_way_at: Date | null;
}

/** An ON_THE_WAY event already recorded under a submission id. */
interface RecordedOnTheWay {
  type: string;
  deliveryId: string;
  routeId: string | null;

  /** The instant the mark recorded (occurred_at, else created_at). */
  at: Date;
}

interface ApplyOnTheWayInput {
  stopId: string;
  routeId: string;
  businessId: string;
  deliveryId: string;

  /** What the stop keeps: laterOf(previous, at). */
  stopOnTheWayAt: Date;

  /** What this mark records on the event. */
  at: Date;

  reportedById: string;
  client_submission_id: string;
  latitude: number | null;
  longitude: number | null;
}

/**
 * The one write "a caminho" makes, and the reads it decides on.
 *
 * Its own repository, and a narrow one: marking a stop is a unit of work
 * across two tables (the stop's instant and the delivery's event) that no
 * other use case performs, under the same lock order every stop writer uses
 * (route row first — see route-repository's settleWithin).
 *
 * Every read is tenant-scoped in its `where`: a stop of another company reads
 * exactly like one that does not exist.
 */
interface IStopOnTheWayRepository {
  /** The stop of this route and company, or null. */
  findTarget: (
    stopId: string,
    routeId: string,
    businessId: string,
  ) => Promise<OnTheWayTarget | null>;

  /**
   * The event recorded under this submission id within the company, or null.
   * An id used by another company reads as null here; the unique index then
   * refuses the insert.
   */
  findBySubmission: (
    clientSubmissionId: string,
    businessId: string,
  ) => Promise<RecordedOnTheWay | null>;

  /**
   * Locks the route row (FOR UPDATE) and re-reads the stop under it, inside
   * the caller's transaction. Null when the stop left the route or the route
   * is not the company's.
   */
  lockForMark: (
    stopId: string,
    routeId: string,
    businessId: string,
    tx: Prisma.TransactionClient,
  ) => Promise<LockedOnTheWayState | null>;

  /**
   * Stamps the stop and records the ON_THE_WAY event (actor DRIVER_APP, with
   * the route), in the caller's transaction. Throws the unique violation on
   * `client_submission_id` when the id was already used.
   */
  applyMark: (
    input: ApplyOnTheWayInput,
    tx: Prisma.TransactionClient,
  ) => Promise<void>;
}

export type {
  ApplyOnTheWayInput,
  IStopOnTheWayRepository,
  LockedOnTheWayState,
  OnTheWayTarget,
  RecordedOnTheWay,
};
