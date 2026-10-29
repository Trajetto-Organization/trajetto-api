import { Prisma } from "@prisma/client";
import { inject, injectable } from "tsyringe";

import type { IActivityRepository } from "@/modules/activity/repositories/IActivity-repository";
import { DatabaseUnavailableError } from "@/shared/database/pg-driver";
import { logger } from "@/shared/logging/logger";

/** How long the one retry waits for the pool or the server to come back. */
const AUDIT_RETRY_DELAY_MS = 200;

/**
 * Failures where the INSERT certainly never ran: no connection could be
 * taken or opened. Under Prisma 7 the pool is pg's, and its own failures
 * arrive as DatabaseUnavailableError (src/shared/database/pg-driver.ts): a
 * full pool and a connection that could not be opened are told by `reason`.
 * What the adapter maps keeps a Prisma code: refused or unknown host
 * (P1001), Postgres out of connection slots, 53300 (P2037).
 *
 * A connection lost under the statement and a read timeout are left out on
 * purpose (`connection-lost`, `query-timeout`, and P1017/P1008 from the
 * adapter) — a connection that dies after the COMMIT reached Postgres reports
 * the same, and retrying that would write the entry twice. A trail that
 * double-counts is worse than one that is merely incomplete.
 */
function neverReachedTheDatabase(error: unknown): boolean {
  if (error instanceof DatabaseUnavailableError) {
    return error.reason === "pool-timeout" || error.reason === "connect-failed";
  }

  if (error instanceof Prisma.PrismaClientInitializationError) return true;

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (["P1001", "P2037"].includes(error.code)) return true;

    return (
      error.code === "P2028" &&
      /unable to start a transaction/i.test(error.message)
    );
  }

  return false;
}

interface CreateActivityProps {
  type: string;
  action: string;
  entityId: string;
  description: string;
  status: string;
  // Null when no person acted: a delivery created through an API key.
  performedBy: string | null;
  businessId: string | null;
  tenantName?: string | null;
  visibilityLevel?: string;
  performingUserRole?: string;
}

/**
 * The audit-trail entry point of the use cases.
 *
 * User-facing notifications do not pass through here: use cases publish
 * their own topics via `OutboxService.publish` inside the business
 * transaction, and the pipeline's policies do the rest.
 *
 * The entry is written straight to the activity table (GAP2-4). It used to
 * ride the outbox as `activity.recorded` — an event, then an ACTIVITY
 * delivery, then the row: three rows and two updates for one insert, queued
 * behind WhatsApp and e-mail. The event was published after the business
 * commit, outside its transaction, so the queue bought no guarantee the
 * insert does not already have. Hierarchical visibility is handled at query
 * time in ActivityRepository.
 */
@injectable()
class NotificationService {
  constructor(
    @inject("ActivityRepository")
    private activityRepository: IActivityRepository,
  ) {}

  /**
   * Records an audit entry.
   *
   * With `tx` — the sensitive sites: permissions, users, profiles, the
   * company itself — the entry joins the write's transaction, and its failure
   * propagates: the operation rolls back rather than happening unaudited.
   * That inversion is deliberate (OUTBOX-10).
   *
   * Without `tx` it is written right after the operation, at most once: one
   * retry when no connection could be had, then a structured error line
   * (`audit_trail_write_failed`) an alert can match, and the operation is
   * never failed for it.
   */
  async createActivityIfEnabled(
    activityData: CreateActivityProps,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (tx) {
      await this.activityRepository.createActivity(activityData, tx);
      return;
    }

    try {
      await this.writeWithOneRetry(activityData);
    } catch (error) {
      logger.error(
        {
          event: "audit_trail_write_failed",
          type: activityData.type,
          action: activityData.action,
          entityId: activityData.entityId,
          businessId: activityData.businessId,
          performedBy: activityData.performedBy,
          err: error,
        },
        "an audit trail entry could not be written and is lost",
      );
    }
  }

  private async writeWithOneRetry(
    activityData: CreateActivityProps,
  ): Promise<void> {
    try {
      await this.activityRepository.createActivity(activityData);
    } catch (error) {
      if (!neverReachedTheDatabase(error)) throw error;

      await new Promise((resolve) => setTimeout(resolve, AUDIT_RETRY_DELAY_MS));

      await this.activityRepository.createActivity(activityData);
    }
  }
}

export { NotificationService, CreateActivityProps };
