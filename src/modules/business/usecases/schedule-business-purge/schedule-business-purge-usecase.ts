import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";
import { env } from "@/env";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IUsersTokensRepository } from "@/modules/user/repositories/IUsers-tokens-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import type { IBackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { logger } from "@/shared/logging/logger";
import { NotificationService } from "@/shared/services/notification-service";
import { resolveTimeZone } from "@/shared/time/business-day";
import { sendSecurityEventToBusiness } from "@/websocket";

import type { Business } from "../../dtos/business-dto";
import { mailBusinessPurge } from "../../services/business-purge-mail";
import { BusinessNotFoundError } from "../errors/business-not-found-error";
import {
  BusinessPurgeConfirmationError,
  purgeRefusal,
} from "../errors/business-purge-errors";
import { assertCallerRole } from "../errors/business-role-guard";

const log = logger.child({ component: "business" });

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sessions ended at once: a company of drivers has thousands of users. */
const REVOKE_IN_PARALLEL = 10;

interface ScheduleBusinessPurgeRequest {
  businessId: string;
  userId: string;

  /** The company's corporate name, typed by the MASTER: the explicit act. */
  confirmation: string;
}

/**
 * Schedules a company's purge (plano-escala F3-25): the explicit, separate
 * act of a MASTER — never the "desativar" of an unpaid bill, which only
 * blocks the access and keeps everything.
 *
 * In one transaction, from a company never scheduled (`purge_state` NULL;
 * a second click finds it SCHEDULED and is refused): the company becomes
 * inactive (`deactivated_at` now), SCHEDULED, its data going on
 * `purge_after`, TENANT_PURGE_AFTER_DAYS (30) days on; the TENANT_OFFBOARD
 * job is enqueued for that instant; and the audit line. Then, after the
 * commit: the company's sockets are told (business_inactive), its sessions
 * end, and its administrators get the e-mail (and another 7 days before,
 * remind-business-purge). Until `purge_after`, a MASTER can reactivate it
 * with everything in place (cancel-business-purge).
 */
@injectable()
class ScheduleBusinessPurgeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("UsersTokensRepository")
    private tokens: IUsersTokensRepository,
    @inject("BackgroundJobRepository")
    private jobs: IBackgroundJobRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    businessId,
    userId,
    confirmation,
  }: ScheduleBusinessPurgeRequest): Promise<Business> {
    const caller = await this.user.findUserById(userId);

    if (!caller) throw new ResourceNotFoundError();

    // MASTER-only, like the route: see assertCallerRole.
    assertCallerRole(caller, ["MASTER"]);

    const existing = await this.business.findBusinessById(businessId);

    if (!existing) throw new BusinessNotFoundError();

    if (existing.purge_state) {
      throw purgeRefusal(existing.purge_state, "schedule");
    }

    if (confirmation.trim() !== existing.corporate_reason.trim()) {
      throw new BusinessPurgeConfirmationError();
    }

    const purgeAfter = new Date(
      Date.now() + env.TENANT_PURGE_AFTER_DAYS * DAY_MS,
    );
    const purgeOn = purgeAfter.toLocaleDateString("pt-BR", {
      timeZone: resolveTimeZone(existing.timezone),
    });

    const scheduled = await database.$transaction(async (tx) => {
      const updated = await this.business.schedulePurge(
        businessId,
        purgeAfter,
        tx,
      );

      if (!updated) return null;

      await this.jobs.enqueue(
        {
          kind: "TENANT_OFFBOARD",
          businessId,
          subjectId: businessId,
          availableAt: purgeAfter,
          payload: { businessId, scheduledById: userId },
        },
        tx,
      );

      await this.notificationService.createActivityIfEnabled(
        {
          type: "Empresa",
          action: "update",
          entityId: businessId,
          description: `Exclusão da empresa ${updated.corporate_reason} agendada para ${purgeOn} por ${caller.name}; a empresa foi desativada`,
          status: "Exclusão agendada",
          performedBy: userId,
          businessId,
        },
        tx,
      );

      return updated;
    });

    if (!scheduled) {
      // Another click scheduled it (or the purge moved on) meanwhile.
      const now = await this.business.findBusinessById(businessId);

      if (!now) throw new BusinessNotFoundError();

      throw purgeRefusal(now.purge_state ?? "SCHEDULED", "schedule");
    }

    // Every session of the company ends now (decision 4.1's reason): the
    // app and the web log out on business_inactive.
    sendSecurityEventToBusiness(businessId, { reason: "business_inactive" });

    await this.revokeSessions(businessId);

    mailBusinessPurge("scheduled", scheduled, this.user).catch((error) => {
      log.warn(
        { err: error, businessId },
        "administrators could not be told about a scheduled purge",
      );
    });

    return scheduled;
  }

  /** The refresh tokens (and push devices) of every user of the company. */
  private async revokeSessions(businessId: string): Promise<void> {
    const users = await this.user.findUsersByBusiness(businessId);

    for (let start = 0; start < users.length; start += REVOKE_IN_PARALLEL) {
      await Promise.all(
        users
          .slice(start, start + REVOKE_IN_PARALLEL)
          .map((user) => this.tokens.revokeAllUserRefreshTokens(user.id!)),
      );
    }
  }
}

export { ScheduleBusinessPurgeUseCase };
export type { ScheduleBusinessPurgeRequest };
