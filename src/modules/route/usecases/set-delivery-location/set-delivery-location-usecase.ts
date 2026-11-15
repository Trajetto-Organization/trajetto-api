import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";
import { announcePlanChange } from "../shared/route-plan-change";

import { sendRouteEventToDriver } from "@/websocket";

import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";
import {
  announceSettledLookups,
  type StopPointChange,
} from "@/shared/delivery/geocoding/geocoding-announcer";
import { geocodeSoon } from "@/shared/delivery/geocoding/geocode-soon";
import type { IDeliveryGeocodingRepository } from "@/shared/delivery/geocoding/geocoding-repository";
// The box lives with the create's coordinates (plan of 02/11/2026, E1): a
// pin and a point given at the create are refused by the same rule.
import {
  BRAZIL_BOX,
  isInsideBrazil,
} from "@/shared/delivery/address-coordinates";

import type { PinnedLocation } from "../../dtos/route-dto";

interface SetDeliveryLocationRequest {
  userId: string;
  businessId: string;
  deliveryId: string;

  /** Null clears the point. */
  point: { latitude: number; longitude: number } | null;
}

/**
 * The pinned point, and the plan version it produced on the route holding
 * the delivery: the page adopts it, so its own pin is never mistaken for a
 * colleague's change.
 */
type SetDeliveryLocationResult = NonNullable<PinnedLocation["delivery"]> & {
  routeId: string | null;
  planVersion: number | null;
  /**
   * How many other open deliveries of the company at the same address the
   * pin reached (D-24): the ones without a point that took it, and the
   * copies of this delivery's previous point that moved with it; when
   * clearing, the copies cleared with it.
   */
  propagated: number;
};

const log = logger.child({ component: "route", action: "pin" });

/**
 * "Fixar no mapa": the dispatcher says where the address is (D7), with a
 * click on the map or a place found by the address search
 * (GET /address-search/:businessId), confirmed on the page before it is
 * written here. The geocoder's point, when it found one, gives way to it.
 *
 * A plan, not evidence: the proof GPS lives on the delivery events and is
 * never touched here. A DELIVERED or CANCELLED delivery is a closed record
 * and keeps the point it had.
 *
 * With the route running too (D23): a point that was missing or wrong is
 * often found with the truck at the customer's door, and the driver's
 * geofence and navigation read the point. Their phone is told quietly to
 * read the day again (the routeEvent `route-stop.located`, as when the
 * geocoder finds a point): no plan version, no "rota alterada", no push —
 * no stop moved — so it changes nothing for a company whose geofence is
 * off. It is the way out when the point is wrong, never when the GPS read
 * wrong: moving a right point to where a bad fix put the driver stores a
 * wrong address and hides the "Fora do raio" the proof would carry.
 *
 * The other open deliveries of the company at the same address, still
 * without a point, take the pin too, after its commit (owner's report of
 * 14/11/2026, decision D-24): the second delivery at a door the dispatcher
 * just located must not read "Sem localização". They are told like a point
 * the geocoder found — the route pages refetch, the driver of a released or
 * running route rereads the day — with no plan version. Never over a point
 * of their own.
 *
 * And the copies this delivery already handed out follow it (pre-push
 * review of the batch of 14/11/2026: a corrected or cleared pin left them
 * wrong for good). In the pin's commit, the company's open copies still
 * GEOCODER, still holding exactly its previous point and still at its door
 * take the new one — or, when the pin is cleared, lose theirs and go back
 * to the geocoding queue as fresh deliveries without a point, asked about
 * right after (geocodeSoon), so the job may take another point of the door
 * or ask the provider. A copy a person pinned since, one whose address
 * changed, a closed one and another company's never move. They are told
 * the same way (a cleared one as CLEARED, never as a point found). The
 * answer says how many the pin reached (`propagated`).
 */
@injectable()
class SetDeliveryLocationUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryGeocodingRepository")
    private geocoding: Pick<IDeliveryGeocodingRepository, "openStopRoutes">,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
    point,
  }: SetDeliveryLocationRequest): Promise<SetDeliveryLocationResult> {
    await assertRouteDispatcher(this.user, userId, businessId);

    if (point && !isInsideBrazil(point)) {
      throw new AppError(
        "Esse ponto fica fora do Brasil. Confira o lugar no mapa e tente de novo.",
        400,
        "DELIVERY_LOCATION_INVALID",
      );
    }

    const pinned = await this.route.pinDeliveryLocation(
      deliveryId,
      businessId,
      point,
    );

    // Another company's delivery reads exactly like one that does not exist.
    if (!pinned) {
      throw new AppError("Entrega não encontrada.", 404, "DELIVERY_NOT_FOUND");
    }

    if (pinned.locked || !pinned.delivery) {
      throw new AppError(
        "Esta entrega já foi encerrada e o endereço dela não pode mais ser alterado.",
        400,
        "DELIVERY_LOCATION_LOCKED",
      );
    }

    // The point is part of the plan on the route that holds it.
    if (pinned.route) {
      await announcePlanChange(this.user, {
        businessId,
        routeId: pinned.route.routeId,
        routeCode: pinned.route.code,
        planVersion: pinned.route.planVersion,
        status: pinned.route.status,
        driverId: pinned.route.driverId,
      });
    }

    // A running route's plan stays as it was, and only its driver hears of
    // the point. Every app build rereads the day on any routeEvent, silently.
    if (pinned.runningRoute) {
      const driverUser = await this.user.findUserByDriverId(
        pinned.runningRoute.driverId,
      );

      sendRouteEventToDriver(driverUser?.id ?? null, {
        type: "route-stop.located",
        routeId: pinned.runningRoute.routeId,
        deliveryId,
      });
    }

    const { followed } = pinned;

    // The cleared copies are fresh deliveries without a point again: their
    // lookup now, as after a create (never awaited).
    if (!point && followed.length > 0) geocodeSoon(businessId, followed);

    const given = point ? await this.propagate(deliveryId, businessId) : [];

    await announceSettledLookups(this.geocoding, [
      ...followed.map((id): StopPointChange => ({
        id,
        businessId,
        kind: point ? "RESOLVED" : "CLEARED",
      })),
      ...given.map((id): StopPointChange => ({
        id,
        businessId,
        kind: "RESOLVED",
      })),
    ]);

    return {
      ...pinned.delivery,
      routeId: pinned.route?.routeId ?? null,
      planVersion: pinned.route?.planVersion ?? null,
      propagated: followed.length + given.length,
    };
  }

  /**
   * The pin, given to the other open deliveries at the same door still
   * without a point. The pin itself is committed (its copies' follow-up
   * with it): a failure here costs only these copies (the job reuses the
   * point on its next claim of them), never the answer.
   */
  private async propagate(
    deliveryId: string,
    businessId: string,
  ): Promise<string[]> {
    try {
      return await this.route.propagateAddressPoint(deliveryId, businessId);
    } catch (err) {
      log.warn(
        { err, businessId, deliveryId },
        "pin not propagated to the other deliveries at the same address",
      );

      return [];
    }
  }
}

export { BRAZIL_BOX, SetDeliveryLocationUseCase, isInsideBrazil };
export type { SetDeliveryLocationRequest, SetDeliveryLocationResult };
