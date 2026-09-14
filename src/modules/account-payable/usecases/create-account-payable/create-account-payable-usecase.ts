import { inject, injectable } from "tsyringe";
import { IAccountPayableRepository } from "@/modules/account-payable/repositories/IAccount-payable-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { ServiceOrderNotBelongBusinessError } from "@/modules/service-order/usecases/errors/service-order-not-belong-business-error";

import { ServiceOrderNotFoundError } from "@/modules/service-order/usecases/errors/service-order-not-found-error";
import { AccountPayableInvalidAmountError } from "../errors/account-payable-invalid-amount-error";

import {
  AccountPayable,
  CreateAccountPayableProps,
} from "../../dtos/account-payable-dto";

import { OutboxService } from "@/shared/notifications/outbox-service";

import { AppError } from "@/shared/errors/AppError";
import database from "@/../infra/database";

@injectable()
class CreateAccountPayableUseCase {
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
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

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
      throw new BranchNotBelongBusinessError();
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
        throw new ServiceOrderNotBelongBusinessError();
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
      // Bill and outbox event commit together; the pipeline notifies the
      // responsible user and records the activity after the commit.
      const accountPayableCreated = await database.$transaction(async (tx) => {
        const created = await this.accountPayable.createAccountPayable(
          accountPayableData,
          tx,
        );

        await this.outbox.publish(tx, {
          topic: "account-payable.created",
          aggregateType: "account-payable",
          aggregateId: created.id,
          businessId: accountPayableData.businessId,
          actorId: userId,
          payload: {
            accountPayableId: created.id,
            businessId: accountPayableData.businessId,
            amount: Number(created.amount),
            serviceOrderId: (created.serviceOrderId as string) || null,
            registrationUserId: accountPayableData.registrationUserId,
          },
        });

        return created;
      });

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
