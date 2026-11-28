import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import { IRouteRepository } from "../../repositories/IRoute-repository";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { isRouteLeftOpen, leftOpenDays } from "@/shared/route/route-left-open";

import type { LeftOpenRoute } from "../../dtos/route-dto";
import type { RouteLeftOpenPayload } from "@/shared/notifications/notification-types";

interface AlertRoutesLeftOpenRequest {
  /** The clock. Only tests pass it. */
  now?: Date;
}

/**
 * Running routes read per sweep. A fleet's worth: the routes on the street
 * across every company, oldest departure first, so a backlog drains over
 * the next runs rather than in one burst.
 */
const LEFT_OPEN_SWEEP_BATCH = 500;

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** "30/10 às 14:57", in the company's zone. */
function sinceLabel(instant: Date, timeZone: string): string {
  let formatter = wallFormatters.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("pt-BR", {
      timeZone,
      hourCycle: "h23",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    wallFormatters.set(timeZone, formatter);
  }

  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";

  return `${part("day")}/${part("month")} às ${part("hour")}:${part("minute")}`;
}

/**
 * The hourly sweep of routes left open (plan of 02/11/2026, K11; decision
 * D26): a route still "Em andamento" that started before its company's
 * today, or more than 16 h ago, is announced to the company's admins —
 * once per route.
 *
 * Safe across replicas and repeated runs by construction, like the tower's
 * escalation: the routes are read without a lock, the due ones are claimed
 * by one conditional UPDATE over SKIP LOCKED rows that stamps
 * left_open_alerted_at, and the notice is published in that same
 * transaction under a key unique per route. Whatever runs the sweep, however
 * often, a route is announced at most once.
 *
 * Returns the ids of the routes announced by this run.
 */
@injectable()
class AlertRoutesLeftOpenUseCase {
  constructor(
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

  async execute({ now = new Date() }: AlertRoutesLeftOpenRequest = {}): Promise<
    string[]
  > {
    const running = await this.route.listUnalertedRunningRoutes(
      LEFT_OPEN_SWEEP_BATCH,
    );

    // Each company's own day: "before today" is read in its zone.
    const due = running.filter((route) =>
      isRouteLeftOpen(route.started_at, route.timeZone, now),
    );

    if (due.length === 0) return [];

    const byId = new Map(due.map((route) => [route.id, route]));

    return database.$transaction(async (tx) => {
      const claimed = await this.route.claimLeftOpenAlerts(
        [...byId.keys()],
        now,
        tx,
      );

      for (const id of claimed) {
        const route = byId.get(id) as LeftOpenRoute;

        await this.outbox.publish(tx, {
          topic: "route.left_open",
          aggregateType: "route",
          aggregateId: route.id,
          businessId: route.businessId,
          eventKey: `route.left_open:${route.id}`,
          payload: {
            routeId: route.id,
            businessId: route.businessId,
            code: route.code,
            routeName: route.name,
            driverName: route.driverName,
            startedAt: route.started_at.toISOString(),
            sinceLabel: sinceLabel(route.started_at, route.timeZone),
            openDays: leftOpenDays(route.started_at, route.timeZone, now),
          } satisfies RouteLeftOpenPayload,
        });
      }

      return claimed;
    });
  }
}

export { AlertRoutesLeftOpenUseCase, LEFT_OPEN_SWEEP_BATCH };
