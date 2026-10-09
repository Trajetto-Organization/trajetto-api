import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IDriverPositionRepository } from "../../repositories/IDriver-position-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import {
  acceptPings,
  latestPing,
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
 * No client key, unlike every other write the app makes: the point itself is
 * the key. (driverId, recorded_at) is unique (20260924090800), so a batch the
 * phone resends after a lost response is absorbed point by point and answered
 * with `stored: 0` for what was already there. It used to be stored again,
 * inflating the distance and the time of the trail a dispute is settled with
 * (IDEMP-16). The index already existed on those columns; being unique costs
 * only the check.
 *
 * Each point is credited to the running route only if it was recorded after
 * the route left (routeOfPing): a backlog from before is the driver's, not
 * this route's.
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

    // The running route's id, and nothing else. This used to load the whole
    // route — driver, vehicle, every stop and delivery — on every flush of
    // every driver on the road, to read two fields.
    const route = await this.route.findActiveRouteForDriver(
      businessId,
      driverId,
    );

    // Only while a route is actually running. A phone that keeps reporting
    // after the last stop is a phone spending a driver's battery on a map
    // nobody is watching, and a trail from someone at home on a Sunday is
    // data we have no business holding.
    const tracking = route !== null;

    if (!tracking) {
      return { stored: 0, rejected: pings.length, tracking: false };
    }

    const { accepted, rejected } = acceptPings(pings);

    if (accepted.length === 0) {
      return { stored: 0, rejected, tracking };
    }

    const { stored, dropped } = await this.positions.recordBatch({
      driverId,
      businessId,
      routeId: route.id,
      routeStartedAt: route.started_at,
      pings: accepted,
    });

    // Every point was older than any partition (INV-14): nothing new to
    // announce, and a dot from weeks ago is not where the truck is.
    if (dropped === accepted.length) {
      return { stored, rejected: rejected + dropped, tracking };
    }

    // The tower, after the write. Only the NEWEST point by device time: the
    // socket is a hint about where the truck is now, and replaying a
    // three-hour backlog through it would redraw the same dot two hundred
    // times for every open panel. Not the last element of the body — a
    // resent older batch would put the truck back where it was.
    const latest = latestPing(accepted);

    sendDriverPositionToBusiness(businessId, {
      driverId,
      // The running route, as before: the socket says whose truck this is
      // now, and its payload's routeId is not nullable for the panels that
      // read it. The stored rows carry the per-point attribution.
      routeId: route.id,
      latitude: latest.latitude,
      longitude: latest.longitude,
      speed: latest.speed,
      heading: latest.heading,
      recordedAt: latest.recorded_at.toISOString(),
    });

    // Dropped points count as refused: the phone clears them either way.
    return { stored, rejected: rejected + dropped, tracking };
  }
}

export { RecordDriverPositionsUseCase };
