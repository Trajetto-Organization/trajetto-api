import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IOperationDayRepository } from "../../repositories/IOperation-day-repository";

import {
  PANEL_DRIVER_REFUSAL,
  resolveOperationsBusiness,
} from "../control-tower/operations-viewer";

import { AppError } from "@/shared/errors/AppError";

import { driverDayLoads } from "@/shared/route/control-tower-rules";
import { operationDay } from "@/shared/route/operation-day-rules";
import { resolveTimeZone } from "@/shared/time/business-day";

interface DriverMonitoringRequest {
  userId: string;
  businessId?: string;

  /** "YYYY-MM-DD" in the company's zone. Defaults to the company's today. */
  day?: string;

  /** The clock. Only tests pass it. */
  now?: Date;
}

interface DriverDayRow {
  driverId: string;
  driverName: string;
  cnh: string;

  /** PENDING on the day's routes (or on a route running now). */
  designated: number;
  inRoute: number;
  deliveredToday: number;
  failedToday: number;
}

interface DriverMonitoring {
  day: string;
  timeZone: string;
  drivers: DriverDayRow[];
}

/**
 * The monitoring board by driver, on the tower's definition of the day
 * (decision 7.1, DLV-MON-3).
 *
 * It read the operation summary, where "designadas" are PENDING of any date:
 * tomorrow's load sat in today's bar and the per-driver numbers never added
 * up to the tower's funnel. These are the same active documents the funnel
 * counts, split by driver.
 *
 * Manager surface, like the tower: a driver token is refused.
 */
@injectable()
class DriverMonitoringUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OperationDayRepository")
    private operation: IOperationDayRepository,
  ) {}

  async execute({
    userId,
    businessId,
    day,
    now = new Date(),
  }: DriverMonitoringRequest): Promise<DriverMonitoring> {
    const resolvedBusinessId = await resolveOperationsBusiness(this.user, {
      userId,
      businessId,
      driverRefusal: PANEL_DRIVER_REFUSAL,
    });

    const timeZone = resolveTimeZone(
      await this.operation.timeZoneOf(resolvedBusinessId),
    );

    let window;

    try {
      window = operationDay(timeZone, now, day);
    } catch {
      throw new AppError("Data inválida.", 400, "INVALID_DAY");
    }

    const loads = driverDayLoads(
      await this.operation.countDayDeliveries(resolvedBusinessId, window),
    );

    // After the counts, not beside them: one connection per request.
    const drivers = new Map(
      (
        await this.operation.listDrivers(
          resolvedBusinessId,
          loads.map((load) => load.driverId),
        )
      ).map((driver) => [driver.id, driver]),
    );

    const rows = loads.map((load) => ({
      ...load,
      driverName: drivers.get(load.driverId)?.name ?? "",
      cnh: drivers.get(load.driverId)?.cnh ?? "",
    }));

    // Whoever is on the street comes first; ties read alphabetically.
    rows.sort(
      (a, b) =>
        b.inRoute - a.inRoute ||
        a.driverName.localeCompare(b.driverName, "pt-BR") ||
        a.driverId.localeCompare(b.driverId),
    );

    return { day: window.date, timeZone, drivers: rows };
  }
}

export { DriverMonitoringUseCase, type DriverDayRow, type DriverMonitoring };
