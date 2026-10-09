import { businessDateKey, dateOnlyKey } from "@/shared/time/business-day";

/**
 * The rules of a route's PLAN — its day, its window and its free texts — kept
 * pure so the zod layer, the use cases and the web mirror say the same thing.
 *
 * Decisions 1.3/1.4/6.5: the day is a civil date; the planned departure and
 * return are instants with an offset; the departure happens ON the route's
 * day, read in the company's own zone (Business.timezone), and the return is
 * never before the departure — nor, when there is no departure, before the
 * route's day (the web's calendar never offers an earlier day either). The zod layer cannot know the company's zone,
 * so it checks only the order of the two instants; the use case checks both,
 * with the zone, and against the stored values on a partial edit.
 */

/** Longest name a dispatcher types ("Zona Sul — manhã"). */
const ROUTE_NAME_MAX = 80;

/** Longest destination ("CD Cajamar — doca 4"). Decision 6.5. */
const ROUTE_DESTINATION_MAX = 160;

/**
 * The refusals, word for word the same on the web
 * (trajetto-ui/src/schemas/create-update-route-schema).
 */
const ROUTE_PLAN_MESSAGES = {
  arrivalBeforeDeparture:
    "O retorno previsto deve ser igual ou posterior à saída prevista.",
  departureOffDay: "A saída prevista deve ser no dia da rota.",
  arrivalBeforeDay: "O retorno previsto não pode ser antes do dia da rota.",
} as const;

type RoutePlanField = "planned_departure_at" | "planned_arrival_at";

interface RoutePlanIssue {
  field: RoutePlanField;
  message: string;
}

interface RoutePlanInput {
  /** The route's day: a date-only value (UTC midnight of the civil day). */
  scheduledDate: Date;
  departure: Date | null | undefined;
  arrival: Date | null | undefined;
  /** The company's zone, already resolved (resolveTimeZone). */
  timeZone: string;
}

/** The return is not before the departure. Zone-free, so zod runs it too. */
function windowOrderIssues(
  departure: Date | null | undefined,
  arrival: Date | null | undefined,
): RoutePlanIssue[] {
  if (!departure || !arrival) return [];

  return arrival.getTime() < departure.getTime()
    ? [{ field: "planned_arrival_at", message: ROUTE_PLAN_MESSAGES.arrivalBeforeDeparture }]
    : [];
}

/**
 * Every rule of the window, with the company's zone.
 *
 * The departure is compared by its civil day IN THE COMPANY'S ZONE: 22:30 of
 * the 17th in São Paulo is 01:30Z of the 18th, and a check in UTC would
 * refuse the evening departure of the route of the 17th.
 */
function routePlanIssues({
  scheduledDate,
  departure,
  arrival,
  timeZone,
}: RoutePlanInput): RoutePlanIssue[] {
  const issues: RoutePlanIssue[] = [];

  if (departure && businessDateKey(departure, timeZone) !== dateOnlyKey(scheduledDate)) {
    issues.push({
      field: "planned_departure_at",
      message: ROUTE_PLAN_MESSAGES.departureOffDay,
    });
  }

  const order = windowOrderIssues(departure, arrival);

  // One refusal per field: a return before the departure is already told.
  if (
    order.length === 0 &&
    arrival &&
    businessDateKey(arrival, timeZone) < dateOnlyKey(scheduledDate)
  ) {
    issues.push({
      field: "planned_arrival_at",
      message: ROUTE_PLAN_MESSAGES.arrivalBeforeDay,
    });
  }

  return issues.concat(order);
}

/**
 * "17/09" for the route's day, as the driver's push says it.
 *
 * A date-only value is UTC midnight of the civil day, so it is formatted IN
 * UTC. In the process's zone it only looked right because the container runs
 * in UTC: anywhere west of it (a developer's machine in São Paulo) the route
 * of the 17th was announced for the 16th.
 */
function routeDayLabel(scheduledDate: Date): string {
  return scheduledDate.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });
}

export {
  ROUTE_DESTINATION_MAX,
  ROUTE_NAME_MAX,
  ROUTE_PLAN_MESSAGES,
  routeDayLabel,
  routePlanIssues,
  windowOrderIssues,
};
export type { RoutePlanField, RoutePlanInput, RoutePlanIssue };
