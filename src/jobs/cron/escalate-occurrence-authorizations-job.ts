import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import { OccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/occurrence-authorization-repository";
import { EscalateOccurrenceAuthorizationsUseCase } from "@/modules/delivery/usecases/authorize-occurrence/escalate-occurrence-authorizations-usecase";
import { OutboxService } from "@/shared/notifications/outbox-service";
import type { OccurrenceTicketService } from "@/modules/chat/usecases/shared/ticket-operations";
import { container } from "tsyringe";

const log = logger.child({
  component: "cron",
  job: "escalate-occurrence-authorizations",
});

/**
 * A driver waiting for the tower for ten minutes is escalated to the
 * company's administrators, once (decision 6.3).
 *
 * Every minute, so the escalation lands between minute 10 and 11. Quiet:
 * a run with nothing due is the normal case. Idempotent and bounded by the
 * claim (escalated_at, SKIP LOCKED, unique outbox key), so a catch-up run or
 * a second replica never escalates twice.
 */
const escalateOccurrenceAuthorizationsJob: CronJobDefinition = {
  name: "escalate-occurrence-authorizations",
  schedule: "* * * * *",
  quiet: true,

  async handler() {
    const escalated = await new EscalateOccurrenceAuthorizationsUseCase(
      new OccurrenceAuthorizationRepository(),
      new OutboxService(),
      // Registered by @/shared (the process's container): the supersede
      // trail on the occurrence's ticket (tickets design §5.2).
      container.isRegistered("OccurrenceTicketService")
        ? container.resolve<OccurrenceTicketService>("OccurrenceTicketService")
        : undefined,
    ).execute();

    if (escalated.length > 0) {
      log.info(
        { escalated: escalated.length },
        "occurrence authorizations without an answer were escalated to the administrators",
      );
    }
  },
};

export { escalateOccurrenceAuthorizationsJob };
