import { AppError } from "@/shared/errors/AppError";

const ARRIVAL_BEFORE_ROUTE_END =
  "Este checklist de chegada foi feito antes da última entrega da rota. Faça um novo checklist de chegada, com a quilometragem e o estado do veículo de agora.";

/**
 * An arrival checklist (ROUTE_END) dated before the route's work ended: a
 * stop of the route was delivered, or failed, after the checklist's own
 * moment (shared/vehicle/route-link.ts, arrivalBeforeRouteEndRefusal). It
 * reports the vehicle before that stop, so it is not the route's arrival.
 *
 * Final, unlike CHECKLIST_ARRIVAL_ROUTE_OPEN: the same checklist meets the
 * same answer forever, so the app's outbox fails it and the route's step
 * offers a new one, which, made now, passes. 409, like the other refusal of
 * the arrival; `laterStops` says how many stops were resolved after it, and
 * the app decides on the code alone.
 */
class VehicleChecklistArrivalBeforeRouteEndError extends AppError {
  constructor(readonly laterStops: number) {
    super(ARRIVAL_BEFORE_ROUTE_END, 409, "CHECKLIST_ARRIVAL_BEFORE_ROUTE_END");
    this.name = "VehicleChecklistArrivalBeforeRouteEndError";
  }
}

export { VehicleChecklistArrivalBeforeRouteEndError };
