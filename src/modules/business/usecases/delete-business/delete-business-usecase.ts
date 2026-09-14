import { inject, injectable } from "tsyringe";
import { compare } from "bcrypt";

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
import { env } from "@/env";

const roleLabels: Record<string, string> = {
  MASTER: "Master",
  BUSINESS_ADMIN: "Admin",
  BUSINESS_USER: "Usuário",
};

@injectable()
class DeleteBusinessUseCase {
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("PendingDeletionProvider")
    private pendingDeletion: IPendingDeletionProvider,
    @inject("NotificationService")
    private notificationService: NotificationService,
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

    const isCodeValid = await compare(code, pending.code_hash);

    if (!isCodeValid) {
      throw new BusinessDeletionCodeInvalidError();
    }

    // Snapshot info BEFORE deletion (for notification email + activity log)
    const businessSnapshot = {
      name: existingBusiness.corporate_reason,
      cnpj: existingBusiness.cnpj,
    };

    try {
      const businessDeleted = await this.business.deleteBusiness(businessId);
      await this.pendingDeletion.deletePendingDeletion(pending.id);

      this.notificationService.createActivityIfEnabled({
        type: "Empresa",
        action: "delete",
        entityId: businessId,
        description:
          `Empresa excluída: ${businessSnapshot.name} | CNPJ: ${businessSnapshot.cnpj} | ID: ${businessDeleted.id} | ` +
          `Excluída por: ${findUser.name} (${findUser.email}) — ${roleLabels[findUser.role] || findUser.role}`,
        status: "Deletado",
        performedBy: userId,
        businessId: null,
        tenantName: businessDeleted.corporate_reason,
      });

      // Notify other MASTER users (excluding the deleter)
      this.notifyOtherMasters({
        deleterId: findUser.id,
        deleterName: findUser.name,
        deleterEmail: findUser.email,
        deleterRole: roleLabels[findUser.role] || findUser.role,
        businessName: businessSnapshot.name,
        businessCnpj: businessSnapshot.cnpj,
      }).catch((err) => {
        console.warn("Failed to notify masters about business deletion:", err);
      });

      return businessDeleted;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar deletar a empresa! Por favor, tente novamente.",
        500,
      );
    }
  }

  private async notifyOtherMasters(params: {
    deleterId: string;
    deleterName: string;
    deleterEmail: string;
    deleterRole: string;
    businessName: string;
    businessCnpj: string;
  }): Promise<void> {
    const masters = await this.user.findOtherMasters(params.deleterId);

    const recipients = masters.filter((m) => m.email_notifications_enabled);
    if (recipients.length === 0) return;

    const deletedAt = new Date().toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
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
            logo: this.cloudinaryLogo,
          },
        }),
      ),
    );
  }
}

export { DeleteBusinessUseCase };
