import { inject, injectable } from "tsyringe";
import {
  assertTenantAccess,
  foreignRecordRefusal,
} from "@/modules/middlewares/tenant-authorization";

import { IAccountPayableRepository } from "@/modules/account-payable/repositories/IAccount-payable-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { AccountPayableNotNotBelongBusinessError } from "../errors/account-payable-not-belong-business-error";
import { AccountPayableNotFoundError } from "../errors/account-payable-not-found-error";

import { AccountPayableNotDeleteHasAlreadyPaidError } from "../errors/account-payable-not-delete-has-already-paid-error";
import { NotificationService } from "@/shared/services/notification-service";

import { AccountPayable } from "../../dtos/account-payable-dto";
import { formatCurrency } from "@/shared/utils/format-values";

import { AppError } from "@/shared/errors/AppError";

@injectable()
class DeleteAccountPayableUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("AccountPayableRepository")
    private accountPayable: IAccountPayableRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    accountPayableId: string,
    businessId: string,
    userId: string,
  ): Promise<AccountPayable> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Defense in depth: the route guard must not be the only wall between tenants.
    assertTenantAccess(findUser, businessId);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // Check if the account payable exists
    const findAccountPayable =
      await this.accountPayable.findAccountPayableById(accountPayableId);

    if (!findAccountPayable) {
      throw new AccountPayableNotFoundError();
    }

    // Check if the account payable belongs to the company
    if (findAccountPayable.businessId !== businessId) {
      // A tenant user reaches here only with their own company in the path
      // (the tenant guard), so a mismatch is someone else's row: 404, like
      // an id that does not exist.
      throw foreignRecordRefusal(
        findUser,
        () => new AccountPayableNotNotBelongBusinessError(),
        () => new AccountPayableNotFoundError(),
      );
    }

    // Check if the bill has already been paid
    if (findAccountPayable.payment_date) {
      throw new AccountPayableNotDeleteHasAlreadyPaidError();
    }

    try {
      const deletedAccountPayable =
        await this.accountPayable.deleteAccountPayable(
          accountPayableId,
          businessId,
        );

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Conta a pagar",
        action: "delete",
        entityId: deletedAccountPayable.id,
        description: `Conta deletada no valor de ${formatCurrency(Number(deletedAccountPayable.amount))} | ID: ${deletedAccountPayable.id}`,
        status: "Deletado",
        performedBy: userId,
        businessId,
      });

      return deletedAccountPayable;
    } catch (error) {
      // Paid between the check above and the delete: the 409 stands.
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar excluir a conta a pagar! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteAccountPayableUseCase };
