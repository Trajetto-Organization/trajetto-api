import { inject, injectable } from "tsyringe";
import { compareSecret } from "@/shared/security/bcrypt-gate";

import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IPendingDeletionProvider } from "@/shared/providers/pending-deletion-provider/IPendingDeletion-provider";

import { Branch } from "../../dtos/branch-dto";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "../errors/branch-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { BranchHasChildrenError } from "../errors/branch-has-children-error";
import { BranchDeletionCodeInvalidError } from "../errors/branch-deletion-code-invalid-error";

import { BranchDeletionCodeExpiredError } from "../errors/branch-deletion-code-expired-error";
import { BranchNoPendingDeletionError } from "../errors/branch-no-pending-deletion-error";

import { NotificationService } from "@/shared/services/notification-service";
import { resolveTimeZone } from "@/shared/time/business-day";
import { sendCatalogChangedEvent } from "@/websocket";
import { sendTransactionalMail } from "@/shared/services/transactional-mail-service";

import { AppError } from "@/shared/errors/AppError";
import { logger } from "@/shared/logging/logger";
import { env } from "@/env";

const log = logger.child({ component: "branch" });

const dependencyLabels: Record<string, string> = {
  vehicles: "veículo(s)",
  drivers: "motorista(s)",
  serviceOrders: "ordem(ns) de serviço",
  accountsPayable: "conta(s) a pagar",
  fines: "multa(s)",
  fuels: "abastecimento(s)",
  vehicleChecklists: "checklist(s) de veículo",
};

const roleLabels: Record<string, string> = {
  MASTER: "Master",
  BUSINESS_ADMIN: "Admin",
  BUSINESS_USER: "Usuário",
};

@injectable()
class DeleteBranchUseCase {
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("PendingDeletionProvider")
    private pendingDeletion: IPendingDeletionProvider,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    branchId: string,
    businessId: string,
    userId: string,
    code: string,
  ): Promise<Branch> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    assertTenantAccess(findUser, businessId);

    const findBranch = await this.branch.findBranchById(branchId);

    // Another company's branch answers like a missing one (decision 11.3).
    if (!findBranch || findBranch.businessId !== businessId) {
      throw new BranchNotFoundError();
    }

    // Re-validate dependencies (race protection)
    const dependencies = await this.branch.countBranchDependencies(branchId);
    const details: string[] = [];

    for (const [key, count] of Object.entries(dependencies)) {
      if (count > 0) {
        const label = dependencyLabels[key] || key;
        details.push(`${count} ${label}`);
      }
    }

    if (details.length > 0) {
      throw new BranchHasChildrenError(`Existem ${details.join(", ")}.`);
    }

    // Validate confirmation code
    const pending = await this.pendingDeletion.findPendingDeletion({
      entity_type: "branch",
      entity_id: branchId,
      userId: findUser.id,
    });

    if (!pending) {
      throw new BranchNoPendingDeletionError();
    }

    if (new Date() > pending.expires) {
      await this.pendingDeletion.deletePendingDeletion(pending.id);
      throw new BranchDeletionCodeExpiredError();
    }

    const isCodeValid = await compareSecret(code, pending.code_hash);

    if (!isCodeValid) {
      throw new BranchDeletionCodeInvalidError();
    }

    // Snapshot info BEFORE deletion (for notification email + activity log)
    const branchSnapshot = {
      name: findBranch.corporate_reason,
      cnpj: findBranch.cnpj,
    };

    try {
      const deletedBranch = await this.branch.deleteBranch(branchId);
      await this.pendingDeletion.deletePendingDeletion(pending.id);

      this.notificationService.createActivityIfEnabled({
        type: "Filial",
        action: "delete",
        entityId: deletedBranch.id,
        description:
          `Filial excluída: ${branchSnapshot.name} | CNPJ: ${branchSnapshot.cnpj} | ID: ${deletedBranch.id} | ` +
          `Excluída por: ${findUser.name} (${findUser.email}) — ${roleLabels[findUser.role] || findUser.role}`,
        status: "Deletado",
        performedBy: userId,
        businessId: businessId,
      });

      sendCatalogChangedEvent(businessId, "branch");

      // Notify other business admins (excluding the deleter)
      this.notifyOtherAdmins({
        businessId,
        deleterId: findUser.id,
        deleterName: findUser.name,
        deleterEmail: findUser.email,
        deleterRole: roleLabels[findUser.role] || findUser.role,
        branchName: branchSnapshot.name,
        branchCnpj: branchSnapshot.cnpj,
        businessName: findBusiness.corporate_reason,
        timeZone: resolveTimeZone(findBusiness.timezone),
      }).catch((err) => {
        log.warn(
          { err, businessId, branchId },
          "admins could not be notified about a branch deletion",
        );
      });

      return deletedBranch;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar excluir a filial! Por favor, tente novamente.",
        500,
      );
    }
  }

  private async notifyOtherAdmins(params: {
    businessId: string;
    deleterId: string;
    deleterName: string;
    deleterEmail: string;
    deleterRole: string;
    branchName: string;
    branchCnpj: string;
    businessName: string;
    /** The company's zone: the e-mail states when, on its clock. */
    timeZone: string;
  }): Promise<void> {
    const admins = await this.user.findBusinessAdminsByBusinessId(
      params.businessId,
    );

    const recipients = admins.filter(
      (a) => a.id !== params.deleterId && a.email_notifications_enabled,
    );

    if (recipients.length === 0) return;

    const deletedAt = new Date().toLocaleString("pt-BR", {
      timeZone: params.timeZone,
    });

    await Promise.allSettled(
      recipients.map((recipient) =>
        sendTransactionalMail({
          email: recipient.email,
          name: recipient.name,
          subject: `[Trajetto] Filial "${params.branchName}" foi excluída`,
          templateName: "branch-deletion-notification.hbs",
          moduleName: "branch",
          additionalVariablesProperties: {
            branchName: params.branchName,
            branchCnpj: params.branchCnpj,
            businessName: params.businessName,
            performedByName: params.deleterName,
            performedByEmail: params.deleterEmail,
            performedByRole: params.deleterRole,
            deletedAt,
            logo: this.cloudinaryLogo,
          },
        }),
      ),
    );
  }
}

export { DeleteBranchUseCase };
