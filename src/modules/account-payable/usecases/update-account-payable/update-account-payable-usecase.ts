import { inject, injectable } from "tsyringe";
import { IAccountPayableRepository } from "@/modules/account-payable/repositories/IAccount-payable-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { UserRegisterUserNotFoundError } from "@/modules/user/usecases/errors/user-register-user-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { ServiceOrderNotFoundError } from "@/modules/service-order/usecases/errors/service-order-not-found-error";
import { AccountPayablePaymentRequiredError } from "../errors/account-payable-payment-required-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { ServiceOrderNotBelongBusinessError } from "@/modules/service-order/usecases/errors/service-order-not-belong-business-error";

import { AccountPayableNotFoundError } from "../errors/account-payable-not-found-error";
import { AccountPayableNotAllowedTransferCompaniesError } from "../errors/account-payable-not-allowed-transfer-companies-error";

import { AccountPayableInvalidAmountError } from "../errors/account-payable-invalid-amount-error";

import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";

import {
  AccountPayable,
  UpdateAccountPayableProps,
} from "../../dtos/account-payable-dto";
import { formatCurrency } from "@/shared/utils/format-values";

import { buildAccountPayableLink } from "@/shared/utils/link-redirect-page";
import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";

import { env } from "@/env";

interface AccountPayableNotificationTextProps {
  amount: string;
  serviceOrderId?: string;
  accountPaybleId: string;
}

@injectable()
class UpdateAccountPayableUseCase {
  private http_request = env.HTTP_REQUEST;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("BranchRepository")
    private branch: IBranchRepository,
    @inject("ServiceOrderRepository")
    private serviceOrder: IServiceOrderRepository,
    @inject("AccountPayableRepository")
    private accountPayable: IAccountPayableRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  private buildAccountPayableNotificationText({
    amount,
    serviceOrderId,
    accountPaybleId,
  }: AccountPayableNotificationTextProps): string {
    return [
      `💰 *Conta a Pagar Atualizada! Você foi designado como responsável por uma conta a pagar atualizada*`,
      `Valor: *${formatCurrency(Number(amount))}*`,
      `Identificador da conta a pagar: *${accountPaybleId}*`,
      serviceOrderId && `Identificador da ordem de serviço: *${serviceOrderId}`,
      `Para mais detalhes, acesse o sistema.`,
    ].join("\n");
  }

  private async processNotifications(
    originalAccountPayable: AccountPayable,
    updatedAccountPayable: AccountPayable,
    accountPayableData: UpdateAccountPayableProps,
    userId: string,
    businessId: string,
  ): Promise<void> {
    try {
      // Always create activity for account payable update
      const activityData = {
        type: "Conta a pagar",
        action: "update",
        entityId: updatedAccountPayable.id,
        description: `Conta a pagar atualizada com sucesso, no valor de ${formatCurrency(Number(updatedAccountPayable.amount))} | ID: ${updatedAccountPayable.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId,
      };

      // Check if registrationUserId changed
      const registrationUserChanged =
        accountPayableData.registrationUserId !== undefined &&
        originalAccountPayable.registrationUserId !==
          accountPayableData.registrationUserId;

      if (registrationUserChanged && accountPayableData.registrationUserId) {
        // RegistrationUser changed, send notification
        const registrationUser = await this.user.findUserById(
          accountPayableData.registrationUserId,
        );

        if (registrationUser) {
          const notificationLink = buildAccountPayableLink({
            baseUrl: this.http_request,
            role: registrationUser.role,
            driverId: registrationUser.driverId,
            accountPayableId: updatedAccountPayable.id,
          });

          const notificationData = {
            userId: accountPayableData.registrationUserId,
            type: "account-payable",
            title: "Conta a Pagar Atualizada e Atribuída",
            message: `Você foi designado como responsável por uma conta a pagar atualizada ${updatedAccountPayable.serviceOrderId ? `| ordem de serviço associada ${updatedAccountPayable.serviceOrderId}` : ""}`,
            entityId: updatedAccountPayable.id,
            link: notificationLink,
            businessId,
            shouldSendEmail: true,
            shouldSendWhatsApp: true,
            whatsAppMessage: this.buildAccountPayableNotificationText({
              amount: updatedAccountPayable.amount as string,
              serviceOrderId: updatedAccountPayable.serviceOrderId as string,
              accountPaybleId: updatedAccountPayable.id,
            }),
            instanceName: generateWhatsAppInstanceName(
              registrationUser.email,
              businessId,
            ),
          };

          // Process notification to newly assigned user
          await this.notificationService.processUserNotifications({
            notification: notificationData,
            activity: activityData,
          });
        } else {
          // Fallback: Create activity even if registration user not found
          await this.notificationService.createActivityIfEnabled(activityData);
        }
      } else {
        // No registrationUser change, just create activity
        await this.notificationService.createActivityIfEnabled(activityData);
      }
    } catch (error) {
      console.error(
        "[Contas a pagar Update] Erro ao processar notificações:",
        error,
      );
      // Does not prevent the account payable update
    }
  }

  async execute(
    accountPayableData: UpdateAccountPayableProps,
    accountPayableId: string,
    businessId: string,
    userId: string,
  ): Promise<AccountPayable> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findAccountPayable =
      await this.accountPayable.findAccountPayableById(accountPayableId);

    if (!findAccountPayable) {
      throw new AccountPayableNotFoundError();
    }

    if (
      findAccountPayable.businessId !== businessId &&
      findUser.role !== "MASTER"
    ) {
      throw new AccountPayableNotAllowedTransferCompaniesError();
    }

    if (accountPayableData.branchId) {
      const findBranch = await this.branch.findBranchById(
        accountPayableData.branchId,
      );

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== businessId) {
        throw new BranchNotBelongBusinessError();
      }
    }

    // Check the work order if provided
    if (accountPayableData.serviceOrderId) {
      const findServiceOrder = await this.serviceOrder.findServiceOrderById(
        accountPayableData.serviceOrderId,
      );

      if (!findServiceOrder) {
        throw new ServiceOrderNotFoundError();
      }

      if (findServiceOrder.businessId !== businessId) {
        throw new ServiceOrderNotBelongBusinessError();
      }
    }

    // Checking values
    // If you are updating the amount or amount paid
    let finalAmount =
      accountPayableData.amount !== undefined
        ? accountPayableData.amount
        : Number(findAccountPayable.amount);

    let finalAmountPaid =
      accountPayableData.amount_paid !== undefined
        ? accountPayableData.amount_paid
        : findAccountPayable.amount_paid
          ? Number(findAccountPayable.amount_paid)
          : null;

    // Check that the amount paid is not greater than the total amount
    if (finalAmountPaid && finalAmountPaid > finalAmount) {
      throw new AccountPayableInvalidAmountError();
    }

    // If you are adding a paid amount, we need to ensure there is a payment date
    if (
      finalAmountPaid &&
      !findAccountPayable.payment_date &&
      !accountPayableData.payment_date
    ) {
      // If you are setting a payout amount but not a payout date
      accountPayableData.payment_date = new Date();
    }

    // If you are adding a payment date, we need to ensure there is a paid amount
    if (accountPayableData.payment_date && !finalAmountPaid) {
      throw new AccountPayablePaymentRequiredError();
    }

    if (!accountPayableData.registrationUserId) {
      accountPayableData.registrationUserId = userId;
    } else {
      const findRegistrationUser = await this.user.findUserById(
        accountPayableData.registrationUserId,
      );

      if (!findRegistrationUser) {
        throw new UserRegisterUserNotFoundError();
      }

      if (findRegistrationUser.businessId !== businessId) {
        throw new UserNotBelongBusinessError();
      }
    }

    try {
      const updatedData = {
        ...accountPayableData,
        businessId: businessId,
      };

      const updatedAccountPayable =
        await this.accountPayable.updateAccountPayable({
          accountPayableData: updatedData,
          accountPayableId,
        });

      // Process notifications (activity + conditionally WhatsApp/Email)
      this.processNotifications(
        findAccountPayable,
        updatedAccountPayable,
        accountPayableData,
        userId,
        businessId,
      );

      return updatedAccountPayable;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar a conta a pagar! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateAccountPayableUseCase };
