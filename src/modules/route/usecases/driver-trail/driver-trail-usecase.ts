import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverPositionRepository } from "../../repositories/IDriver-position-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import { downsample } from "@/shared/route/driver-position-rules";

interface DriverTrailRequest {
  userId: string;
  driverId: string;

  businessId?: string;

  /** ISO day. Defaults to today. */
  day?: string;
}

interface TrailPoint {
  latitude: number;
  longitude: number;

  speed: number | null;
  recordedAt: string;
}

interface DriverTrail {
  driverId: string;
  day: string;

  /** How many points exist, before thinning. The screen says so. */
  recorded: number;

  points: TrailPoint[];
}

/**
 * The most points a trail hands to a browser.
 *
 * A ten-hour day at one ping every fifteen seconds is 2.400 points for ONE
 * driver, and the shape of the route is identical at a tenth of them. Four
 * hundred is generous for a polyline and still small enough that opening five
 * drivers at once does not freeze the tab.
 */
const TRAIL_POINT_LIMIT = 400;

/**
 * `YYYY-MM-DD` read as a LOCAL calendar day.
 *
 * `new Date("2026-09-16")` is midnight UTC, which in São Paulo is nine in the
 * evening on the 15th — the exact off-by-one this function exists to avoid.
 * Returns an invalid Date for anything that is not a date, so the caller's
 * `Number.isNaN` check still does its job.
 */
function startOfLocalDay(day: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());

  if (!match) return new Date(NaN);

  const [, year, month, date] = match;

  return new Date(Number(year), Number(month) - 1, Number(date));
}

/**
 * The same calendar day back out, in local wall time.
 *
 * `at.toISOString().slice(0, 10)` would agree with this everywhere WEST of
 * Greenwich and be off by a day east of it, because a local midnight at UTC+9
 * is three in the afternoon of the previous day in UTC. It is written the
 * long way for that reason alone.
 *
 * Not covered by a test, and the reason is worth stating rather than hiding:
 * proving it needs the process to run in a timezone ahead of UTC, and Node on
 * this Windows machine ignores `TZ` — both in the runner and from the shell.
 * A test that set it would report success while measuring the local timezone,
 * which is worse than none. The E2E covers the window, which is where the
 * damage was.
 */
function localDayString(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const date = String(at.getDate()).padStart(2, "0");

  return `${year}-${month}-${date}`;
}

/**
 * Where one driver went on one day.
 *
 * Asked for only when somebody opens a driver, never as part of the tower's
 * refresh: the tower draws where trucks ARE, and a screen that fetched every
 * driver's whole day every few seconds would be the heaviest query in the
 * product serving decoration.
 */
@injectable()
class DriverTrailUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverPositionRepository")
    private positions: IDriverPositionRepository,
  ) {}

  async execute({
    userId,
    driverId,
    businessId,
    day,
  }: DriverTrailRequest): Promise<DriverTrail> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (findUser.driverId) {
      throw new AppError(
        "A torre de controle é superfície do gestor.",
        403,
        "DRIVER_CANNOT_VIEW_PANELS",
      );
    }

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    // The driver has to be theirs. Without this the trail of anybody's driver
    // is one id away — and a trail is where a person was, all day.
    const driver = await database.driver.findFirst({
      where: { id: driverId, businessId: resolvedBusinessId },
      select: { id: true },
    });

    // The same 404 for "does not exist" and "is not yours".
    if (!driver) {
      throw new AppError(
        "Motorista não encontrado.",
        404,
        "DRIVER_NOT_FOUND",
      );
    }

    /**
     * The day is the OPERATION's day, not the UTC one.
     *
     * This used to read `setUTCHours(0, 0, 0, 0)`, and in São Paulo the UTC
     * day begins at nine the previous evening. So a dispatcher who opened a
     * driver's trail after 21:00 — which is exactly when the late routes are
     * the ones being asked about — got a window that started an hour ago and
     * a `recorded` count far below what the phone had actually sent. The
     * morning was simply not there.
     *
     * A trail is the evidence in a dispute about where a truck was at two in
     * the afternoon. Answering "no data" because the server's clock had
     * already rolled over in another timezone is the worst possible way to
     * lose that argument.
     *
     * `day` is therefore an ISO date in local wall time. Parsed by parts
     * rather than by `new Date(string)`, which reads `YYYY-MM-DD` as UTC and
     * would put the boundary back where it was.
     */
    const from = day ? startOfLocalDay(day) : new Date();

    if (Number.isNaN(from.getTime())) {
      throw new AppError("Data inválida.", 400, "INVALID_DAY");
    }

    from.setHours(0, 0, 0, 0);

    const to = new Date(from);
    to.setDate(to.getDate() + 1);

    const recorded = await this.positions.listTrail({
      businessId: resolvedBusinessId,
      driverId,
      from,
      to,
    });

    return {
      driverId,
      day: localDayString(from),

      // The real count, alongside the thinned points. A screen that showed
      // only what it drew would have somebody conclude the phone stopped
      // reporting.
      recorded: recorded.length,

      points: downsample(recorded, TRAIL_POINT_LIMIT).map((point) => ({
        latitude: point.latitude,
        longitude: point.longitude,
        speed: point.speed,
        recordedAt: point.recorded_at.toISOString(),
      })),
    };
  }
}

export { DriverTrailUseCase, TRAIL_POINT_LIMIT, type DriverTrail };
