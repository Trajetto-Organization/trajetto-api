/**
 * A driver's pause (decision 6.1): meal, rest or other, started and ended by
 * the driver from the app, possibly offline and replayed later.
 */

const DRIVER_PAUSE_KINDS = ["MEAL", "REST", "OTHER"] as const;

type DriverPauseKind = (typeof DRIVER_PAUSE_KINDS)[number];

/** The row as the database holds it. */
interface DriverPause {
  id: string;
  kind: DriverPauseKind;

  /** The PAUSE occurrence type (decision 14.4); NOT NULL in the table. */
  occurrenceTypeId: string;

  started_at: Date;
  ended_at: Date | null;

  start_latitude: number | null;
  start_longitude: number | null;
  end_latitude: number | null;
  end_longitude: number | null;

  note: string | null;

  start_submission_id: string;
  end_submission_id: string | null;

  driverId: string;
  businessId: string;
  routeId: string | null;

  created_at: Date;
  updated_at: Date;
}

/** What a new pause row carries; the rest are column defaults. */
interface CreateDriverPauseData {
  kind: DriverPauseKind;
  started_at: Date;

  /** Set only when the end reached us before the start (out-of-order outbox). */
  ended_at?: Date | null;

  start_latitude?: number | null;
  start_longitude?: number | null;
  end_latitude?: number | null;
  end_longitude?: number | null;

  note?: string | null;

  start_submission_id: string;
  end_submission_id?: string | null;

  driverId: string;
  businessId: string;
  routeId?: string | null;

  /**
   * The PAUSE occurrence type chosen (decision 14.4). Absent = the company's
   * seeded type of `kind`'s nature (the installed app sends `kind` alone).
   * Given = it must be this company's PAUSE type of this `kind`, or the
   * insert answers `invalid-type` (the FK alone would take any tenant's id).
   */
  occurrenceTypeId?: string;
}

/**
 * The outcome of an insert, decided by the database's unique indexes rather
 * than by a read before it: two replicas handling the same outbox resend, or
 * two taps, race between any read and the write.
 */
type CreateDriverPauseResult =
  | { status: "created"; pause: DriverPause }
  /** (businessId, start_submission_id) already exists: a resend. */
  | { status: "start-submission-taken" }
  /** (businessId, end_submission_id) already exists. */
  | { status: "end-submission-taken" }
  /** driver_pause_one_open_idx: this driver already has an open pause. */
  | { status: "already-open" }
  /**
   * occurrenceTypeId is not a PAUSE type of this company with this kind
   * (another tenant's, another category, or another nature).
   */
  | { status: "invalid-type" };

interface CloseDriverPauseData {
  pauseId: string;
  businessId: string;
  ended_at: Date;
  end_submission_id: string;
  end_latitude?: number | null;
  end_longitude?: number | null;
}

type CloseDriverPauseResult =
  | { status: "closed"; pause: DriverPause }
  /** Somebody else closed it first (or it never was open). */
  | { status: "not-open" }
  /** The end key already closed another pause of this company. */
  | { status: "end-submission-taken" };

/** A route's time on the street, as the report reads it. */
interface PauseReportRoute {
  id: string;
  driverId: string;
  status: "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  started_at: Date;

  /** completed_at; for a cancelled route, when it was cancelled; null while running. */
  ended_at: Date | null;
}

/** A PAUSE occurrence type as the pause routes read it (decision 14.4). */
interface PauseTypeInfo {
  id: string;
  name: string;
  category: "DELIVERED" | "NOT_DELIVERED" | "PAUSE";
  /** The legal nature; null outside PAUSE. */
  pause_kind: DriverPauseKind | null;
  is_active: boolean;
}

/** A pause as the report reads it. */
type PauseReportPause = Pick<
  DriverPause,
  | "id"
  | "kind"
  | "started_at"
  | "ended_at"
  | "note"
  | "routeId"
  | "driverId"
  | "start_submission_id"
  | "end_submission_id"
> & {
  /** The PAUSE type's name now (decision 14.4); absent in older sources. */
  occurrence_type_name?: string | null;
};

interface PauseReportDriver {
  id: string;
  name: string;
}

/** One company's activity in an instant range, what the report is built from. */
interface PauseReportSource {
  pauses: PauseReportPause[];
  routes: PauseReportRoute[];
  drivers: PauseReportDriver[];
}

interface PauseReportQuery {
  businessId: string;

  /**
   * Drivers to name even without activity in the range (a filter chip that
   * must keep its label). The rows are never narrowed by it: the report's
   * driver facet counts every driver.
   */
  extraDriverNames?: string[];

  /** [start, end): pauses and routes that STARTED inside it. */
  start: Date;
  end: Date;
}

export { DRIVER_PAUSE_KINDS };
export type {
  CloseDriverPauseData,
  CloseDriverPauseResult,
  CreateDriverPauseData,
  CreateDriverPauseResult,
  DriverPause,
  DriverPauseKind,
  PauseReportDriver,
  PauseReportPause,
  PauseReportQuery,
  PauseReportRoute,
  PauseReportSource,
  PauseTypeInfo,
};
