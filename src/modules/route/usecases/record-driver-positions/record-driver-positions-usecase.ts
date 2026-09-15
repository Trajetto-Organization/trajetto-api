import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IDriverPositionRepository } from "../../repositories/IDriver-position-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import {
  acceptPings,
  type RawPing,
} from "@/shared/route/driver-position-rules";

import { sendDriverPositionToBusiness } from "@/shared/route/route-realtime";

interface RecordDriverPositionsRequest {
  userId: string;
  pings: RawPing[];
}

interface RecordDriverPositionsResult {
  stored: number;
  rejected: number;

  /**
   * Whether the app should keep tracking.
   *
   * The phone asks by sending; the answer comes back in the same round trip
   * rather than in a second poll, because the one thing worse than not
   * tracking is tracking after the route ended — a driver's battery spent on
   * a map nobody is watching.
   */
  tracking: boolean;
}

/**
 * The driver's phone reporting where it is, while a route of theirs runs.
 *
 * The driver comes from the SESSION and never from the body. A body-supplied
 * driverId on this route would let any phone write anybody's trail, and the
 * trail is what a dispute is settled with.
 *
 * Nothing here is idempotent by a client key, unlike every other write the app
 * makes. That is deliberate: a resent position is a duplicate dot at the same
 * coordinates at the same second, which draws identically and thins away. An
 * idempotency key per ping would be a unique index on the hottest write path
 * in the product to prevent something invisible.
 */
@injectable()
class RecordDriverPositionsUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("DriverPositionRepository")
    private positions: IDriverPositionRepository,
  ) {}

  async execute({
    userId,
    pings,
  }: RecordDriverPositionsRequest): Promise<RecordDriverPositionsResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    if (!findUser.driverId) {
      throw new AppError(
        "Apenas o aplicativo do motorista envia posições.",
        403,
        "NOT_A_DRIVER",
      );
    }

    if (!findUser.businessId) {
      throw new AppError(
        "Empresa não identificada.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    const businessId = findUser.businessId;
    const driverId = findUser.driverId;

    const route = await this.route.findDriverRoute(businessId, driverId);

    // Only while a route is actually running. A phone that keeps reporting
    // after the last stop is a phone spending a driver's battery on a map
    // nobody is watching, and a trail from someone at home on a Sunday is
    // data we have no business holding.
    const tracking = route?.status === "IN_PROGRESS";

    if (!tracking) {
      return { stored: 0, rejected: pings.length, tracking: false };
    }

    const { accepted, rejected } = acceptPings(pings);

    if (accepted.length === 0) {
      return { stored: 0, rejected, tracking };
    }

    const stored = await this.positions.recordBatch({
      driverId,
      businessId,
      routeId: route.id,
      pings: accepted,
    });

    // The tower, after the write. Only the LAST point: the socket is a hint
    // about where the truck is now, and replaying a three-hour backlog through
    // it would redraw the same dot two hundred times for every open panel.
    const latest = accepted[accepted.length - 1];

    sendDriverPositionToBusiness(businessId, {
      driverId,
      routeId: route.id,
      latitude: latest.latitude,
      longitude: latest.longitude,
      speed: latest.speed,
      heading: latest.heading,
      recordedAt: latest.recorded_at.toISOString(),
    });

    return { stored, rejected, tracking };
  }
}

export { RecordDriverPositionsUseCase };
