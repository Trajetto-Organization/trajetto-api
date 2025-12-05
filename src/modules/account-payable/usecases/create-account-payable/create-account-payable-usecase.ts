import { inject, injectable } from "tsyringe";
import { IAccountPayableRepository } from "@/modules/account-payable/repositories/IAccount-payable-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { ServiceOrderNotFoundError } from "@/modules/service-order/usecases/errors/service-order-not-found-error";
import { AccountPayableInvalidAmountError } from "../errors/account-payable-invalid-amount-error";

import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";
import {
  AccountPayable,
  CreateAccountPayableProps,
} from "../../dtos/account-payable-dto";

import { formatCurrency } from "@/config/format-values";
import { NotificationService } from "@/shared/services/notification-service";

import { buildAccountPayableLink } from "@/shared/utils/link-redirect-page";

import { AppError } from "@/shared/errors/AppError";
import { env } from "@/env";

interface AccountPayableNotificationTextProps {
  serviceOrderId?: string;
  accountPaybleId: string;
  amount: string;
}

@injectable()
class CreateAccountPayableUseCase {
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
      `💰 *Nova Conta a Pagar! Você foi designado como responsável por uma nova conta a pagar*`,
      `Valor: *${formatCurrency(Number(amount))}*`,
      `Identificador da conta a pagar: *${accountPaybleId}*`,
      serviceOrderId && `Identificador da ordem de serviço: *${serviceOrderId}`,
      `Para mais detalhes, acesse o sistema.`,
    ].join("\n");
  }

  private async processNotifications(
    accountPayableCreated: AccountPayable,
    accountPayableData: CreateAccountPayableProps,
    userId: string,
  ): Promise<void> {
    try {
      // Create activity for the user who created the account payable
      const activityData = {
        type: "Conta a pagar",
        action: "create",
        entityId: accountPayableCreated.id,
        description: `Conta a pagar criada com sucesso, no valor de ${formatCurrency(Number(accountPayableCreated.amount))} | ID: ${accountPayableCreated.id}`,
        status: "Completo",
        performedBy: userId,
        businessId: accountPayableData.businessId,
      };

      // Set the registration user to the current user if not provided
      const registrationUserId = accountPayableData.registrationUserId;

      // Check if the registration user exists
      const findRegistrationUser =
        await this.user.findUserById(registrationUserId);

      if (findRegistrationUser) {
        const notificationLink = buildAccountPayableLink({
          baseUrl: this.http_request,
          role: findRegistrationUser.role,
          driverId: findRegistrationUser.driverId,
          accountPayableId: accountPayableCreated.id,
        });

        const notificationData = {
          userId: registrationUserId,
          type: "account-payable",
          title: "Nova Conta a Pagar",
          message: `Você foi designado como responsável por uma nova conta a pagar ${accountPayableCreated.serviceOrderId ? `| ordem de serviço associada ${accountPayableCreated.serviceOrderId}` : ""}`,
          entityId: accountPayableCreated.id,
          link: notificationLink,
          businessId: accountPayableData.businessId,
          shouldSendEmail: true,
          shouldSendWhatsApp: true,
          whatsAppMessage: this.buildAccountPayableNotificationText({
            amount: accountPayableCreated.amount as string,
            serviceOrderId: accountPayableCreated.serviceOrderId as string,
            accountPaybleId: accountPayableCreated.id,
          }),
          instanceName: generateWhatsAppInstanceName(
            findRegistrationUser.email,
            accountPayableData.businessId,
          ),
        };

        // Process notification to assigned user (if different from creator)
        await this.notificationService.processUserNotifications({
          notification: notificationData,
          activity: activityData,
        });
      } else {
        // Fallback: Create activity even if registration user not found
        await this.notificationService.createActivityIfEnabled(activityData);
      }
    } catch (error) {
      console.error("[Contas a pagar] Erro ao processar notificações:", error);
      // Does not prevent the creation of the account payable
    }
  }

  async execute(
    accountPayableData: CreateAccountPayableProps,
    userId: string,
  ): Promise<AccountPayable> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findBusiness = await this.business.findBusinessById(
      accountPayableData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Check if the branch exists and belongs to the company
    const findBranch = await this.branch.findBranchById(
      accountPayableData.branchId,
    );

    if (!findBranch) {
      throw new BranchNotFoundError();
    }

    if (findBranch.businessId !== accountPayableData.businessId) {
      throw new AppError("Esta filial não pertence a esta empresa!", 403);
    }

    // Check the work order if provided
    if (accountPayableData.serviceOrderId) {
      const findServiceOrder = await this.serviceOrder.findServiceOrderById(
        accountPayableData.serviceOrderId,
      );

      if (!findServiceOrder) {
        throw new ServiceOrderNotFoundError();
      }

      if (findServiceOrder.businessId !== accountPayableData.businessId) {
        throw new AppError(
          "Esta ordem de serviço não pertence a esta empresa!",
          403,
        );
      }
    }

    // Check that the amount paid is not greater than the total amount
    if (
      accountPayableData.amount_paid &&
      accountPayableData.amount_paid > accountPayableData.amount
    ) {
      throw new AccountPayableInvalidAmountError();
    }

    try {
      const accountPayableCreated =
        await this.accountPayable.createAccountPayable(accountPayableData);

      // Process notifications asynchronously without blocking the main flow
      this.processNotifications(
        accountPayableCreated,
        accountPayableData,
        userId,
      );

      return accountPayableCreated;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar a conta a pagar! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateAccountPayableUseCase };
