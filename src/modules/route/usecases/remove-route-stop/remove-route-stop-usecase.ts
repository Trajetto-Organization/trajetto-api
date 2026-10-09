import { inject, injectable } from "tsyringe";

import { AppError } from "@/shared/errors/AppError";

import { RemoveRouteStopsUseCase } from "../remove-route-stops/remove-route-stops-usecase";

interface RemoveRouteStopRequest {
  userId: string;
  businessId: string;
  routeId: string;
  stopId: string;
}

/**
 * Takes a delivery off a route that has not left, and puts it back in the
 * unassigned pool.
 *
 * Deleted rather than cancelled, and that is the one place in this module
 * where a row disappears: a stop removed while planning never happened. A
 * CANCELLED stop means "the driver was sent here and it was called off",
 * which is a different fact and belongs in the history; a plan that was edited
 * before anyone saw it does not.
 *
 * The delivery keeps its own status — being taken off a route never changed
 * it. Only the driver and vehicle shadow is cleared.
 */
@injectable()
class RemoveRouteStopUseCase {
  constructor(
    @inject(RemoveRouteStopsUseCase)
    private removeStops: RemoveRouteStopsUseCase,
  ) {}

  /**
   * The single-stop endpoint, kept for the clients that call it, on the
   * batch rules (decision 14.7, §4.4): one writer for "a stop leaves the
   * plan", so the version, the timeline and the realtime hint come with it.
   *
   * Its own contract stays: a stop that is not there — not this route's,
   * not your company's, or on a route that already left — is the same 404.
   */
  async execute({
    userId,
    businessId,
    routeId,
    stopId,
  }: RemoveRouteStopRequest): Promise<void> {
    const notFound = () =>
      new AppError(
        "Parada não encontrada nesta rota, ou a rota já saiu e não pode " +
          "mais ser editada.",
        404,
        "ROUTE_STOP_NOT_FOUND",
      );

    let result;

    try {
      result = await this.removeStops.execute({
        userId,
        businessId,
        routeId,
        stopIds: [stopId],
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "ROUTE_STATUS_CONFLICT") {
        throw notFound();
      }

      throw error;
    }

    if (result.removed.length === 0) throw notFound();
  }
}

export { RemoveRouteStopUseCase };
export type { RemoveRouteStopRequest };
