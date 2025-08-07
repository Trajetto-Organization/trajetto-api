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

import { AccountPayableNotFoundError } from "../errors/account-payable-not-found-error";
import { AccountPayableInvalidAmountError } from "../errors/account-payable-invalid-amount-error";

import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";
import { NotificationService } from "@/shared/services/notification-service";

import { AppError } from "@/shared/errors/AppError";

import {
  AccountPayable,
  UpdateAccountPayableProps,
} from "../../dtos/account-payable-dto";
import { formatCurrency } from "@/config/format-values";

@injectable()
class UpdateAccountPayableUseCase {
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
      throw new AppError(
        "Você não tem permissão para transferir contas entre empresas!",
        403,
      );
    }

    if (accountPayableData.branchId) {
      const findBranch = await this.branch.findBranchById(
        accountPayableData.branchId,
      );

      if (!findBranch) {
        throw new BranchNotFoundError();
      }

      if (findBranch.businessId !== businessId) {
        throw new AppError("Esta filial não pertence a esta empresa!", 403);
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
        throw new AppError(
          "Esta ordem de serviço não pertence a esta empresa!",
          403,
        );
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
      throw new AppError(
        "É necessário informar um valor pago ao registrar uma data de pagamento!",
        400,
      );
    }

    if (!accountPayableData.registrationUserId) {
      accountPayableData.registrationUserId = userId;
    } else {
      const findRegistrationUser = await this.user.findUserById(
        accountPayableData.registrationUserId,
      );

      if (!findRegistrationUser) {
        throw new AppError("Usuário de registro não encontrado!", 400);
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

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Conta a pagar",
        action: "update",
        entityId: updatedAccountPayable.id,
        description: `Conta a pagar atualizada com sucesso, no valor de 
        ${formatCurrency(Number(updatedAccountPayable.amount))} | ID: ${updatedAccountPayable.id}`,
        status: "Atualizado",
        performedBy: userId,
        businessId,
      });

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
