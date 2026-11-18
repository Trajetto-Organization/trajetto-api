import { inject, injectable } from "tsyringe";
import { assertCallerRole } from "../errors/business-role-guard";
import { compareSecret } from "@/shared/security/bcrypt-gate";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { IPendingDeletionProvider } from "@/shared/providers/pending-deletion-provider/IPendingDeletion-provider";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";

import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { BusinessHasChildrenError } from "@/modules/business/usecases/errors/business-has-children-error";

import { BusinessDeletionCodeInvalidError } from "../errors/business-deletion-code-invalid-error";
import { BusinessDeletionCodeExpiredError } from "../errors/business-deletion-code-expired-error";

import { BusinessNoPendingDeletionError } from "../errors/business-no-pending-deletion-error";

import { Business } from "../../dtos/business-dto";
import { AppError } from "@/shared/errors/AppError";

import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";
import { logger } from "@/shared/logging/logger";
import { resolveTimeZone } from "@/shared/time/business-day";

import database from "@/../infra/database";
import { emailLogoUrl } from "@/shared/providers/mail-provider/email-logo";
import { withMailbox } from "@/modules/user/services/user-mailbox";
import type { IBackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { wakeJobsAfterCommit } from "@/shared/jobs/job-wake";

import { purgeRefusal } from "../errors/business-purge-errors";

const log = logger.child({ component: "business" });

const roleLabels: Record<string, string> = {
  MASTER: "Master",
  BUSINESS_ADMIN: "Admin",
  BUSINESS_USER: "Usuário",
};

/**
 * Deletes a company with the code the MASTER got by e-mail: the old
 * "Deletar", for a company with no branch, user or driver left.
 *
 * Since plano-escala F3-26a it no longer deletes inside the request. The
 * cascade of one DELETE held every row of the company for as long as it
 * took (15 s and more for a company whose ERP created deliveries through
 * the API), and the purge job does the same in short batches. So, in one
 * transaction: the company inactive and SCHEDULED for now, the
 * TENANT_OFFBOARD job enqueued with `removeRow` (the job removes the
 * company's row at the end, freeing its CNPJ as the old delete did, instead
 * of the tombstone of a scheduled purge), and the audit line as before.
 * The answer is the same; the company leaves the list once the job ends,
 * seconds later for an empty company.
 */
@injectable()
class DeleteBusinessUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("PendingDeletionProvider")
    private pendingDeletion: IPendingDeletionProvider,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("BackgroundJobRepository")
    private jobs: IBackgroundJobRepository,
  ) {}

  async execute(
    businessId: string,
    userId: string,
    code: string,
  ): Promise<Business> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // MASTER-only, like the route: see assertCallerRole.
    assertCallerRole(findUser, ["MASTER"]);

    const existingBusiness = await this.business.findBusinessById(businessId);

    if (!existingBusiness) {
      throw new BusinessNotFoundError();
    }

    // Re-validate dependencies (race protection)
    const dependencies =
      await this.business.countBusinessDependencies(businessId);

    const details: string[] = [];

    if (dependencies.branches > 0) {
      details.push(`${dependencies.branches} filial(is) vinculada(s)`);
    }

    if (dependencies.users > 0) {
      details.push(`${dependencies.users} usuário(s) vinculado(s)`);
    }

    if (dependencies.drivers > 0) {
      details.push(`${dependencies.drivers} motorista(s) vinculado(s)`);
    }

    if (details.length > 0) {
      throw new BusinessHasChildrenError(`Existem ${details.join(", ")}.`);
    }

    // Validate confirmation code
    const pending = await this.pendingDeletion.findPendingDeletion({
      entity_type: "business",
      entity_id: businessId,
      userId: findUser.id,
    });

    if (!pending) {
      throw new BusinessNoPendingDeletionError();
    }

    if (new Date() > pending.expires) {
      await this.pendingDeletion.deletePendingDeletion(pending.id);
      throw new BusinessDeletionCodeExpiredError();
    }

    const isCodeValid = await compareSecret(code, pending.code_hash);

    if (!isCodeValid) {
      throw new BusinessDeletionCodeInvalidError();
    }

    // A company whose purge is already on its way keeps it: the code does
    // not start a second one.
    if (existingBusiness.purge_state) {
      throw purgeRefusal(existingBusiness.purge_state, "schedule");
    }

    // Snapshot info BEFORE deletion (for notification email + activity log)
    const businessSnapshot = {
      name: existingBusiness.corporate_reason,
      cnpj: existingBusiness.cnpj,
      timeZone: existingBusiness.timezone,
    };

    let businessDeleted: Business | null;

    try {
      // The purge's schedule, its job and the audit entry commit together
      // (OUTBOX-10); the job deletes the rows and the company.
      businessDeleted = await database.$transaction(async (tx) => {
        const deleted = await this.business.schedulePurge(
          businessId,
          new Date(),
          tx,
        );

        if (!deleted) return null;

        await this.jobs.enqueue(
          {
            kind: "TENANT_OFFBOARD",
            businessId,
            subjectId: businessId,
            payload: { businessId, scheduledById: userId, removeRow: true },
          },
          tx,
        );

        await this.notificationService.createActivityIfEnabled(
          {
            type: "Empresa",
            action: "delete",
            entityId: businessId,
            description:
              `Empresa excluída: ${businessSnapshot.name} | CNPJ: ${businessSnapshot.cnpj} | ID: ${deleted.id} | ` +
              `Excluída por: ${findUser.name} (${findUser.email}) — ${roleLabels[findUser.role] || findUser.role}`,
            status: "Deletado",
            performedBy: userId,
            businessId: null,
            tenantName: deleted.corporate_reason,
          },
          tx,
        );

        return deleted;
      });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar a empresa! Por favor, tente novamente.",
        500,
      );
    }

    if (!businessDeleted) {
      // Another MASTER scheduled or deleted it meanwhile: said as such.
      const now = await this.business.findBusinessById(businessId);

      if (!now) throw new BusinessNotFoundError();

      throw purgeRefusal(now.purge_state ?? "SCHEDULED", "schedule");
    }

    // The code is spent. The purge's own step takes it too, and a job
    // claimed by another process's sweep in between may already have.
    await this.pendingDeletion
      .deletePendingDeletion(pending.id)
      .catch((err: unknown) => {
        log.debug(
          { err, businessId },
          "pending deletion already gone with the purge",
        );
      });

    wakeJobsAfterCommit();

    // Notify other MASTER users (excluding the deleter)
    this.notifyOtherMasters({
      deleterId: findUser.id,
      deleterName: findUser.name,
      deleterEmail: findUser.email,
      deleterRole: roleLabels[findUser.role] || findUser.role,
      businessName: businessSnapshot.name,
      businessCnpj: businessSnapshot.cnpj,
      businessTimeZone: businessSnapshot.timeZone,
    }).catch((err) => {
      log.warn(
        { err, businessId },
        "masters could not be notified about a business deletion",
      );
    });

    return businessDeleted;
  }

  private async notifyOtherMasters(params: {
    deleterId: string;
    deleterName: string;
    deleterEmail: string | null;
    deleterRole: string;
    businessName: string;
    businessCnpj: string;
    businessTimeZone?: string | null;
  }): Promise<void> {
    const masters = await this.user.findOtherMasters(params.deleterId);

    const recipients = withMailbox(
      masters.filter((m) => m.email_notifications_enabled),
    );
    if (recipients.length === 0) return;

    // Masters have no company of their own: the moment is told on the
    // deleted company's clock (decision 1.1), the default without one.
    const deletedAt = new Date().toLocaleString("pt-BR", {
      timeZone: resolveTimeZone(params.businessTimeZone),
    });

    await Promise.allSettled(
      recipients.map((recipient) =>
        sendTransactionalMail({
          email: recipient.email,
          name: recipient.name,
          subject: `[Trajetto] Empresa "${params.businessName}" foi excluída`,
          templateName: "business-deletion-notification.hbs",
          moduleName: "business",
          additionalVariablesProperties: {
            businessName: params.businessName,
            businessCnpj: params.businessCnpj,
            performedByName: params.deleterName,
            performedByEmail: params.deleterEmail,
            performedByRole: params.deleterRole,
            deletedAt,
            logo: emailLogoUrl(),
          },
        }),
      ),
    );
  }
}

export { DeleteBusinessUseCase };
