import type {
  CloseDriverPauseData,
  CloseDriverPauseResult,
  CreateDriverPauseData,
  CreateDriverPauseResult,
  DriverPause,
  PauseReportQuery,
  PauseReportSource,
  PauseTypeInfo,
  DriverPauseKind,
} from "../dtos/driver-pause-dto";

interface IDriverPauseRepository {
  /** The company's zone (Business.timezone); null when the company is gone. */
  timeZoneOf(businessId: string): Promise<string | null>;

  findByStartSubmission(
    businessId: string,
    startSubmissionId: string,
  ): Promise<DriverPause | null>;

  findByEndSubmission(
    businessId: string,
    endSubmissionId: string,
  ): Promise<DriverPause | null>;

  /** The driver's open pause (ended_at IS NULL), if any. At most one exists. */
  findOpenPause(businessId: string, driverId: string): Promise<DriverPause | null>;

  /**
   * The driver's route that was on the street at `at`: started at or before
   * it and not yet finished (completed, or cancelled) by then.
   */
  findRouteRunningAt(
    businessId: string,
    driverId: string,
    at: Date,
  ): Promise<string | null>;

  /**
   * The driver's journey route at `at` (decision 14.4): released by then,
   * not finished by then, and that business day's (`dayKey`, the company's
   * zone) or already started. Null = no journey: a pause may not start.
   */
  findJourneyRouteAt(
    businessId: string,
    driverId: string,
    at: Date,
    dayKey: string,
  ): Promise<string | null>;

  /** This company's occurrence type, any category; null for another tenant's. */
  findPauseType(businessId: string, occurrenceTypeId: string): Promise<PauseTypeInfo | null>;

  /** The company's seeded PAUSE type of this nature, seeding the defaults if missing. */
  defaultPauseType(businessId: string, kind: DriverPauseKind): Promise<PauseTypeInfo>;

  /** Names of these types, this company's only. */
  pauseTypeNames(businessId: string, ids: string[]): Promise<Map<string, string>>;

  createPause(data: CreateDriverPauseData): Promise<CreateDriverPauseResult>;

  /** Closes the pause only while it is still open (conditional write). */
  closePause(data: CloseDriverPauseData): Promise<CloseDriverPauseResult>;

  /** One driver's pauses that started in [start, end), oldest first. */
  listDriverPauses(
    businessId: string,
    driverId: string,
    range: { start: Date; end: Date },
  ): Promise<DriverPause[]>;

  /**
   * Everything the report needs for a range: pauses and routes that started
   * in it (routes only once they left: started_at set), and the names of the
   * company's drivers involved or asked for.
   */
  loadReportSource(query: PauseReportQuery): Promise<PauseReportSource>;
}

export type { IDriverPauseRepository };
