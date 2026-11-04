import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import { RouteRepository } from "@/modules/route/repositories/route-repository";
import { AlertRoutesLeftOpenUseCase } from "@/modules/route/usecases/alert-routes-left-open/alert-routes-left-open-usecase";
import { OutboxService } from "@/shared/notifications/outbox-service";

const log = logger.child({ component: "cron", job: "alert-routes-left-open" });

/**
 * A route left "Em andamento" (plan of 02/11/2026, K11; decision D26) is
 * announced to the company's admins, once.
 *
 * Hourly, at minute 7, off the round hour the open tabs refresh on. Quiet:
 * a run with nothing due is the normal case.
 * Idempotent and bounded by the claim (left_open_alerted_at, SKIP LOCKED,
 * unique outbox key), so a catch-up run or a second replica never announces
 * a route twice.
 */
const alertRoutesLeftOpenJob: CronJobDefinition = {
  name: "alert-routes-left-open",
  schedule: "7 * * * *",
  quiet: true,

  async handler() {
    const announced = await new AlertRoutesLeftOpenUseCase(
      new RouteRepository(),
      new OutboxService(),
    ).execute();

    if (announced.length > 0) {
      log.info(
        { announced: announced.length },
        "routes left open were announced to the administrators",
      );
    }
  },
};

export { alertRoutesLeftOpenJob };
