import { RouteNotFoundError } from "@/modules/route/usecases/errors/route-errors";
import { AppError } from "@/shared/errors/AppError";
import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";
import {
  ENDED_ROUTE_CHECKLIST_WINDOW_MS,
  routeHandsOverVehicle,
} from "@/shared/vehicle/driver-vehicle-access";

/**
 * What ties a vehicle checklist or a refuelling to a route (plan of
 * 02/11/2026, items C4, C5 and F3): the record is what happened to the
 * vehicle on that route, so the route must be the record's driver's and
 * carry the record's vehicle.
 *
 * The route's status is never asked, on purpose: the app queues a departure
 * checklist with photos offline, and it may reach the server after the route
 * left or even ended. The server records it; only the app holds "Iniciar
 * rota" back until the checklist exists (decision D08). A route of another
 * company reads exactly like one that does not exist.
 *
 * Whether that link also proves a DRIVER had the vehicle is another question
 * (routeProvesCustody): there the status and the record's date count.
 */

type ChecklistPhaseValue = "STANDALONE" | "ROUTE_START" | "ROUTE_END";

/** The few columns of a route this rule reads. */
interface LinkedRoute {
  driverId: string;
  vehicleId?: string | null;
}

/** Why this route cannot carry this record, or null when it can. */
function routeLinkRefusal(
  route: LinkedRoute | null,
  record: { driverId?: string | null; vehicleId: string },
): AppError | null {
  // The route module's 404 (DELIVERY_ROUTE_NOT_FOUND), never the router's
  // ROUTE_NOT_FOUND: the app's outbox reads that one as an outdated build
  // and would replay a queued checklist of a deleted route after every
  // upgrade instead of failing it on the merits.
  if (!route) return new RouteNotFoundError();

  if (record.driverId && route.driverId !== record.driverId) {
    return new AppError(
      "A rota informada é de outro motorista.",
      422,
      "ROUTE_LINK_MISMATCH",
    );
  }

  if (!route.vehicleId) {
    return new AppError(
      "A rota informada ainda não tem veículo.",
      422,
      "ROUTE_LINK_MISMATCH",
    );
  }

  if (route.vehicleId !== record.vehicleId) {
    return new AppError(
      "O veículo informado não é o veículo da rota.",
      422,
      "ROUTE_LINK_MISMATCH",
    );
  }

  return null;
}

/** The route facts the custody proof reads. */
interface CustodyRoute {
  status: string;
  released_at?: Date | string | null;
  started_at?: Date | string | null;
  completed_at?: Date | string | null;
  updated_at?: Date | string | null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Whether the route a driver's record names proves the driver had the
 * vehicle when the record was made, standing in for the custody check
 * (canDriverOperateVehicle). Without this bound any old, cancelled or never
 * released route of the driver with truck X opened X to them for good: a
 * refuelling that moves X's odometer, a checklist that alerts the fleet,
 * while X is with somebody else today.
 *
 * - A released or running route hands the vehicle over: it proves custody,
 *   as canDriverOperateVehicle already says.
 * - A planned one is a draft and hands nothing over.
 * - An ended one (COMPLETED, CANCELLED) proves custody only if it ever handed
 *   the vehicle over (released or started) and only for a record dated from
 *   the day of that handover up to its end plus the arrival checklist
 *   window. The end is completed_at; a cancelled route has none, and its
 *   last update is when it was called off. The record's date is the one the
 *   app captured at the gesture (K6), so a record made during the route
 *   lands however late the phone syncs; a bare day is compared by the
 *   company's day, which is why the lower bound is the handover's day.
 *
 * False sends the caller back to canDriverOperateVehicle, never to a
 * refusal of its own: the responsible driver of X still records on X.
 */
function routeProvesCustody(
  route: CustodyRoute,
  recordDate: Date,
  timeZone: string | null | undefined,
): boolean {
  if (routeHandsOverVehicle(route.status)) return true;
  if (route.status !== "COMPLETED" && route.status !== "CANCELLED") {
    return false;
  }

  const handedOverAt = toDate(route.released_at) ?? toDate(route.started_at);
  const endedAt = toDate(route.completed_at) ?? toDate(route.updated_at);

  if (!handedOverAt || !endedAt || Number.isNaN(recordDate.getTime())) {
    return false;
  }

  const zone = resolveTimeZone(timeZone);

  if (businessDateKey(recordDate, zone) < businessDateKey(handedOverAt, zone)) {
    return false;
  }

  return (
    recordDate.getTime() <= endedAt.getTime() + ENDED_ROUTE_CHECKLIST_WINDOW_MS
  );
}

/**
 * A checklist names its moment (departure or arrival) exactly when it names
 * a route (C4, decision D09: one per route). A standalone one names neither.
 */
function checklistPhaseRefusal(
  routeId: string | null | undefined,
  phase: ChecklistPhaseValue | null | undefined,
): AppError | null {
  const routePhase = phase === "ROUTE_START" || phase === "ROUTE_END";

  if (routeId && !routePhase) {
    return new AppError(
      "Informe se o checklist é o de saída ou o de chegada da rota.",
      400,
      "CHECKLIST_ROUTE_PHASE_REQUIRED",
    );
  }

  if (!routeId && routePhase) {
    return new AppError(
      "Informe a rota do checklist de saída ou de chegada.",
      400,
      "CHECKLIST_ROUTE_REQUIRED",
    );
  }

  return null;
}

export { checklistPhaseRefusal, routeLinkRefusal, routeProvesCustody };
export type { ChecklistPhaseValue, CustodyRoute, LinkedRoute };
