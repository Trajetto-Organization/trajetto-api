import { AppError } from "@/shared/errors/AppError";

const ARRIVAL_ROUTE_OPEN =
  "O checklist de chegada só pode ser feito depois que todas as entregas da rota forem resolvidas";

const ARRIVAL_ROUTE_NOT_STARTED =
  "O checklist de chegada só pode ser feito depois que a rota for iniciada e todas as entregas forem resolvidas.";

/**
 * The sentence, with what is left when anything is. Nothing open means the
 * route never left (arrivalChecklistRefusal accepts a started one with
 * nothing open), so that sentence names the start instead of deliveries the
 * driver has no way to find — the app's own reason for it reads the same.
 */
function arrivalRouteOpenMessage(openStops: number): string {
  if (openStops <= 0) return ARRIVAL_ROUTE_NOT_STARTED;

  const left = openStops === 1 ? "falta 1" : `faltam ${openStops}`;

  return `${ARRIVAL_ROUTE_OPEN} (${left}).`;
}

/**
 * An arrival checklist (ROUTE_END) sent while the route still has work left:
 * it has not started, or a stop is still open (shared/vehicle/route-link.ts,
 * arrivalChecklistRefusal). 409, like the other refusals the app's outbox
 * files on the merits; `openStops` rides along so the body can say how many
 * (the checklist error table sends it as `open_stops`). The app decides on
 * the code and shows the message, never on the count.
 */
class VehicleChecklistArrivalRouteOpenError extends AppError {
  constructor(readonly openStops: number) {
    super(
      arrivalRouteOpenMessage(openStops),
      409,
      "CHECKLIST_ARRIVAL_ROUTE_OPEN",
    );
    this.name = "VehicleChecklistArrivalRouteOpenError";
  }
}

export { VehicleChecklistArrivalRouteOpenError };
