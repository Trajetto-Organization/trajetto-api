import { inject, injectable } from "tsyringe";

import { businessNotFound } from "@/shared/delivery/caller-not-found";
import { resolveTimeZone } from "@/shared/time/business-day";

import type { IDriverPauseRepository } from "../../repositories/IDriver-pause-repository";

import {
  PAUSE_LAW,
  ReportRangeInvalid,
  buildPauseReport,
  resolveReportRange,
  summarizePauseReport,
  type DriverDayReport,
  type PauseFlagCode,
  type PauseReportSearchMeta,
} from "../../rules/pause-report-rules";

import { PauseReportRangeError } from "../errors/driver-pause-errors";

interface DriverPauseReportRequest {
  businessId: string;

  /** "YYYY-MM-DD" in the company's zone; see resolveReportRange. */
  from?: string;
  to?: string;

  driverIds?: string[];
  flags?: PauseFlagCode[];

  page: number;
  pageSize: number;

  now?: Date;
}

interface DriverPauseReport {
  timeZone: string;
  from: string;
  to: string;

  /** The thresholds the alerts use, for the screen to state them. */
  rules: typeof PAUSE_LAW;

  total: number;
  page: number;
  pageSize: number;
  searchMeta: PauseReportSearchMeta;
  data: DriverDayReport[];
}

/**
 * The office's pause report (decision 6.1): per driver and business day, the
 * pauses, the workday, estimated driving and the Lei 13.103/2015 alerts.
 *
 * Built in memory from one read of the range (bounded at 31 days, plus the
 * two days before it that the first day's rest between workdays needs), so
 * the driver facet can count every driver while one is chosen.
 */
@injectable()
class DriverPauseReportUseCase {
  constructor(
    @inject("DriverPauseRepository")
    private pauses: IDriverPauseRepository,
  ) {}

  async execute({
    businessId,
    from,
    to,
    driverIds,
    flags,
    page,
    pageSize,
    now = new Date(),
  }: DriverPauseReportRequest): Promise<DriverPauseReport> {
    const zone = await this.pauses.timeZoneOf(businessId);

    if (zone === null) throw businessNotFound();

    const timeZone = resolveTimeZone(zone);

    let range;

    try {
      range = resolveReportRange({ from, to }, timeZone, now);
    } catch (error) {
      if (error instanceof ReportRangeInvalid) {
        throw new PauseReportRangeError(error.message);
      }

      throw error;
    }

    const source = await this.pauses.loadReportSource({
      businessId,
      extraDriverNames: driverIds,
      start: range.loadStart,
      end: range.loadEnd,
    });

    const rows = buildPauseReport({
      timeZone,
      now,
      from: range.from,
      to: range.to,
      source,
    });

    const { rows: kept, searchMeta } = summarizePauseReport(
      rows,
      { driverIds, flags },
      new Map(source.drivers.map((driver) => [driver.id, driver.name])),
    );

    const offset = (page - 1) * pageSize;

    return {
      timeZone,
      from: range.from,
      to: range.to,
      rules: PAUSE_LAW,
      total: kept.length,
      page,
      pageSize,
      searchMeta,
      data: kept.slice(offset, offset + pageSize),
    };
  }
}

export { DriverPauseReportUseCase };
export type { DriverPauseReport, DriverPauseReportRequest };
