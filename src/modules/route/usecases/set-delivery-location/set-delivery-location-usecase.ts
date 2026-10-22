import { inject, injectable } from "tsyringe";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { assertRouteDispatcher } from "../shared/assert-route-dispatcher";
import { announcePlanChange } from "../shared/route-plan-change";

import { AppError } from "@/shared/errors/AppError";

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
};

/**
 * A rough box around Brazil (decision 14.7, §4.11). A click outside the
 * country on a route map is almost always a slip of the mouse, and a stop
 * pinned in the Atlantic would quietly bend the whole plan line.
 */
const BRAZIL_BOX = { minLat: -34, maxLat: 6, minLng: -74, maxLng: -34 };

function isInsideBrazil(point: {
  latitude: number;
  longitude: number;
}): boolean {
  return (
    point.latitude >= BRAZIL_BOX.minLat &&
    point.latitude <= BRAZIL_BOX.maxLat &&
    point.longitude >= BRAZIL_BOX.minLng &&
    point.longitude <= BRAZIL_BOX.maxLng
  );
}

/**
 * "Fixar no mapa": the dispatcher says where the address is (D7). The
 * product has no geocoder yet, so this is how a stop gets onto the map.
 *
 * A plan, not evidence: the proof GPS lives on the delivery events and is
 * never touched here. A DELIVERED or CANCELLED delivery is a closed record
 * and keeps the point it had.
 */
@injectable()
class SetDeliveryLocationUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("UserRepository")
    private user: IUserRepository,
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

    return {
      ...pinned.delivery,
      routeId: pinned.route?.routeId ?? null,
      planVersion: pinned.route?.planVersion ?? null,
    };
  }
}

export { BRAZIL_BOX, SetDeliveryLocationUseCase, isInsideBrazil };
export type { SetDeliveryLocationRequest, SetDeliveryLocationResult };
