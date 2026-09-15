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

    const from = day ? new Date(`${day}T00:00:00.000Z`) : new Date();

    if (Number.isNaN(from.getTime())) {
      throw new AppError("Data inválida.", 400, "INVALID_DAY");
    }

    from.setUTCHours(0, 0, 0, 0);

    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 1);

    const recorded = await this.positions.listTrail({
      businessId: resolvedBusinessId,
      driverId,
      from,
      to,
    });

    return {
      driverId,
      day: from.toISOString().slice(0, 10),

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
