/**
 * How the tower's numbers are computed, away from any query.
 *
 * Each of these is a judgement — what counts as late, what counts as finished,
 * what a day even is — and every one of them will be argued with by somebody
 * looking at the screen. Pure functions so the argument can be settled by
 * reading a test rather than by reading a SQL string.
 */

/**
 * How late a departure has to be before it counts as late.
 *
 * Fifteen minutes. A route that left at 07:03 against a 07:00 plan did not
 * leave late by any standard an operation recognises, and a punctuality number
 * that said so would be a number nobody trusts — which is the same as not
 * having it.
 */
const DEPARTURE_GRACE_MINUTES = 15;

type DeparturePunctuality = "on_time" | "late" | "not_planned" | "not_departed";

/**
 * Whether one route left on time.
 *
 * Four answers and not two, because "não planejado" and "no horário" are
 * different facts and collapsing them flatters the number: an operation that
 * plans no departures would score 100%.
 */
function departurePunctuality(route: {
  planned_departure_at: Date | null;
  started_at: Date | null;
}): DeparturePunctuality {
  if (!route.planned_departure_at) return "not_planned";
  if (!route.started_at) return "not_departed";

  const lateBy =
    route.started_at.getTime() - route.planned_departure_at.getTime();

  return lateBy > DEPARTURE_GRACE_MINUTES * 60 * 1000 ? "late" : "on_time";
}

interface PunctualitySummary {
  onTime: number;
  late: number;

  /** Planned, the hour has passed, and nothing left. */
  notDeparted: number;

  /** No planned hour at all — excluded from the rate, counted here. */
  notPlanned: number;

  /**
   * On-time over what was PLANNED and has departed. Null when nothing was
   * planned: a rate over zero routes is not 100%, it is unanswerable, and
   * showing 100% would be the screen lying on its best day.
   */
  rate: number | null;
}

function summarisePunctuality(
  routes: Array<{ planned_departure_at: Date | null; started_at: Date | null }>,
): PunctualitySummary {
  const summary: PunctualitySummary = {
    onTime: 0,
    late: 0,
    notDeparted: 0,
    notPlanned: 0,
    rate: null,
  };

  for (const route of routes) {
    const verdict = departurePunctuality(route);

    if (verdict === "on_time") summary.onTime += 1;
    else if (verdict === "late") summary.late += 1;
    else if (verdict === "not_departed") summary.notDeparted += 1;
    else summary.notPlanned += 1;
  }

  const judged = summary.onTime + summary.late;

  if (judged > 0) {
    summary.rate = Math.round((summary.onTime / judged) * 1000) / 10;
  }

  return summary;
}

/**
 * The funnel, in the order a document actually moves.
 *
 * Fixed and exhaustive rather than derived from whatever the query returned: a
 * status with no rows today has to show a zero, because "nenhuma entrega
 * falhou hoje" is the single best thing this screen can say and a funnel that
 * omitted the column would never say it.
 */
const FUNNEL_ORDER = [
  "PENDING",
  "IN_TRANSIT",
  "DELIVERED",
  "FAILED",
  "CANCELLED",
] as const;

type FunnelStatus = (typeof FUNNEL_ORDER)[number];

const FUNNEL_LABELS: Record<FunnelStatus, string> = {
  PENDING: "Pendentes",
  IN_TRANSIT: "Em rota",
  DELIVERED: "Entregues",
  FAILED: "Insucesso",
  CANCELLED: "Canceladas",
};

function buildFunnel(
  counts: Array<{ status: string; total: number }>,
): Array<{ status: FunnelStatus; label: string; total: number }> {
  const found = new Map(counts.map((entry) => [entry.status, entry.total]));

  return FUNNEL_ORDER.map((status) => ({
    status,
    label: FUNNEL_LABELS[status],
    total: found.get(status) ?? 0,
  }));
}

/**
 * How much of the day is done.
 *
 * "Finished" is DELIVERED plus FAILED plus CANCELLED: an insucesso is a
 * result, not an interruption, and a progress bar that only counted successes
 * would sit at 80% forever on a day where a fifth of the addresses were
 * refused.
 */
const FINISHED_STATUSES: FunnelStatus[] = ["DELIVERED", "FAILED", "CANCELLED"];

function dayProgress(
  counts: Array<{ status: string; total: number }>,
): { finished: number; total: number; rate: number | null } {
  let finished = 0;
  let total = 0;

  for (const entry of counts) {
    total += entry.total;

    if (FINISHED_STATUSES.includes(entry.status as FunnelStatus)) {
      finished += entry.total;
    }
  }

  return {
    finished,
    total,

    // Null and not zero on an empty day: nothing to do is not no progress, and
    // an empty bar at six in the morning reads as the operation being behind.
    rate: total > 0 ? Math.round((finished / total) * 1000) / 10 : null,
  };
}

export {
  DEPARTURE_GRACE_MINUTES,
  FINISHED_STATUSES,
  FUNNEL_LABELS,
  FUNNEL_ORDER,
  buildFunnel,
  dayProgress,
  departurePunctuality,
  summarisePunctuality,
  type DeparturePunctuality,
  type FunnelStatus,
  type PunctualitySummary,
};
