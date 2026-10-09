import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import { SupportTicketRepository } from "@/modules/chat/repositories/support-ticket-repository";
import { ChatRepository } from "@/modules/chat/repositories/chat-repository";
import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";
import { DriverRepository } from "@/modules/driver/repositories/driver-repository";
import { RepairUnticketedMessagesUseCase } from "@/modules/chat/usecases/tickets/repair-unticketed-messages/repair-unticketed-messages-usecase";

const log = logger.child({ component: "cron", job: "repair-unticketed-messages" });

/**
 * Decision 14.5, rolling deploy: the previous image writes messages without
 * a ticket; this files them every minute (design §9.3). Quiet when there is
 * nothing to do — the normal case once every replica runs the new image.
 * Removed with the legacy routing, after the CHECK of the contract step.
 */
const repairUnticketedMessagesJob: CronJobDefinition = {
  name: "repair-unticketed-messages",
  schedule: "* * * * *",
  quiet: true,

  async handler() {
    const repaired = await new RepairUnticketedMessagesUseCase(
      new SupportTicketRepository(),
      new ChatRepository(),
      new DeliveryRepository(),
      new UserRepository(),
      new DriverRepository(),
    ).execute();

    if (repaired > 0) {
      log.info({ repaired }, "chat messages written without a ticket were filed");
    }
  },
};

export { repairUnticketedMessagesJob };
