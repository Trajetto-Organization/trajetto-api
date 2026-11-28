import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import type { IBackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { NotificationService } from "@/shared/services/notification-service";

import type { Business } from "../../dtos/business-dto";
import { BusinessNotFoundError } from "../errors/business-not-found-error";
import { purgeRefusal } from "../errors/business-purge-errors";
import { assertCallerRole } from "../errors/business-role-guard";

/**
 * Reactivates a company whose purge is scheduled (plano-escala F3-25):
 * active again, the purge columns cleared and its TENANT_OFFBOARD job
 * cancelled, in one transaction — everything the company had is where it
 * was; its users sign in again.
 *
 * Only from SCHEDULED, by a conditional write: a purge that started
 * (PURGING, the job's own transaction moved it under the company's lock)
 * is refused with its own sentence, never half undone; a company never
 * scheduled — an inactive one of before included — is told it has no
 * purge scheduled (its way back is the old "ativar").
 */
@injectable()
class CancelBusinessPurgeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BackgroundJobRepository")
    private jobs: IBackgroundJobRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(businessId: string, userId: string): Promise<Business> {
    const caller = await this.user.findUserById(userId);

    if (!caller) throw new ResourceNotFoundError();

    // MASTER-only, like the route: see assertCallerRole.
    assertCallerRole(caller, ["MASTER"]);

    const existing = await this.business.findBusinessById(businessId);

    if (!existing) throw new BusinessNotFoundError();

    if (existing.purge_state !== "SCHEDULED") {
      throw purgeRefusal(existing.purge_state ?? null, "cancel");
    }

    const reactivated = await database.$transaction(async (tx) => {
      const updated = await this.business.cancelPurge(businessId, tx);

      if (!updated) return null;

      await this.jobs.cancelPending(
        "TENANT_OFFBOARD",
        businessId,
        businessId,
        tx,
      );

      await this.notificationService.createActivityIfEnabled(
        {
          type: "Empresa",
          action: "update",
          entityId: businessId,
          description: `Exclusão da empresa ${updated.corporate_reason} cancelada por ${caller.name}; a empresa foi reativada`,
          status: "Ativo",
          performedBy: userId,
          businessId,
        },
        tx,
      );

      return updated;
    });

    if (!reactivated) {
      // The purge moved on meanwhile (PURGING): said as such.
      const now = await this.business.findBusinessById(businessId);

      if (!now) throw new BusinessNotFoundError();

      throw purgeRefusal(now.purge_state ?? null, "cancel");
    }

    return reactivated;
  }
}

export { CancelBusinessPurgeUseCase };
