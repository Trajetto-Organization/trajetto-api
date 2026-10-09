import { inject, injectable } from "tsyringe";
import {
  assertTenantAccess,
  foreignRecordRefusal,
} from "@/modules/middlewares/tenant-authorization";
import { IAccountPayableRepository } from "@/modules/account-payable/repositories/IAccount-payable-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { AccountPayablePaymentRequiredError } from "../errors/account-payable-payment-required-error";
import { AccountPayableNotFoundError } from "../errors/account-payable-not-found-error";

import { AccountPayableNotNotBelongBusinessError } from "../errors/account-payable-not-belong-business-error";
import { AccountPayableInvalidAmountError } from "../errors/account-payable-invalid-amount-error";
import { AccountPayablePayeeRequiredError } from "../errors/account-payable-payee-required-error";

import { OutboxService } from "@/shared/notifications/outbox-service";
import { AppError } from "@/shared/errors/AppError";

import {
  AccountPayable,
  UpdateAccountPayableProps,
} from "../../dtos/account-payable-dto";

import database from "@/../infra/database";

import { assertAccountPayableReferences } from "../account-payable-references";
import { billDateFromInput } from "../../rules/account-payable-status";

import { serviceOrderOverrunWarning } from "../../rules/service-order-overrun";

type UpdatedAccountPayable = AccountPayable & { warnings: string[] };

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
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("SupplierRepository")
    private supplier: ISupplierRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
  ) {}

  async execute(
    input: UpdateAccountPayableProps,
    accountPayableId: string,
    businessId: string,
    userId: string,
  ): Promise<UpdatedAccountPayable> {
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

    const findAccountPayable =
      await this.accountPayable.findAccountPayableById(accountPayableId);

    if (!findAccountPayable) {
      throw new AccountPayableNotFoundError();
    }

    // For the MASTER too: a mismatch used to be read as "move the bill", and
    // its company was rewritten while its branch, supplier and vehicle
    // stayed in the old one.
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

    const accountPayableData: UpdateAccountPayableProps = { ...input };

    // Required columns: absent or null is "unchanged", never "cleared". An
    // absent responsible used to become whoever saved the form — handing the
    // bill over, and notifying, on an unrelated edit.
    for (const required of [
      "branchId",
      "registrationUserId",
      "category",
      "due_date",
      "amount",
    ] as const) {
      if (accountPayableData[required] === null) {
        delete accountPayableData[required];
      }
    }

    const { serviceOrder } = await assertAccountPayableReferences(
      {
        branch: this.branch,
        serviceOrder: this.serviceOrder,
        supplier: this.supplier,
        vehicle: this.vehicle,
        user: this.user,
      },
      businessId,
      {
        branchId: accountPayableData.branchId,
        serviceOrderId: accountPayableData.serviceOrderId,
        supplierId: accountPayableData.supplierId,
        vehicleId: accountPayableData.vehicleId,
        registrationUserId: accountPayableData.registrationUserId,
      },
    );

    // One payee: naming a supplier clears the free-text name and the other
    // way round, so a bill never says two different things.
    if (accountPayableData.supplierId) {
      accountPayableData.payee_name = null;
    } else if (accountPayableData.payee_name) {
      accountPayableData.supplierId = null;
    }

    // Decision 8.4: sending null for the payee without naming the other one
    // used to leave the bill with none. A legacy bill that never had one
    // may still be edited without inventing it.
    const hadPayee = Boolean(
      findAccountPayable.supplierId || findAccountPayable.payee_name,
    );
    const nextSupplierId =
      accountPayableData.supplierId !== undefined
        ? accountPayableData.supplierId
        : findAccountPayable.supplierId;
    const nextPayeeName =
      accountPayableData.payee_name !== undefined
        ? accountPayableData.payee_name
        : findAccountPayable.payee_name;

    if (hadPayee && !nextSupplierId && !nextPayeeName) {
      throw new AccountPayablePayeeRequiredError();
    }

    const finalAmount =
      accountPayableData.amount !== undefined &&
      accountPayableData.amount !== null
        ? accountPayableData.amount
        : Number(findAccountPayable.amount);

    const finalAmountPaid =
      accountPayableData.amount_paid !== undefined
        ? accountPayableData.amount_paid
        : findAccountPayable.amount_paid
          ? Number(findAccountPayable.amount_paid)
          : null;

    if (finalAmountPaid && finalAmountPaid > finalAmount) {
      throw new AccountPayableInvalidAmountError();
    }

    // A paid amount with no payment date is stamped paid now.
    if (
      finalAmountPaid &&
      !findAccountPayable.payment_date &&
      !accountPayableData.payment_date
    ) {
      accountPayableData.payment_date = new Date();
    }

    if (accountPayableData.payment_date && !finalAmountPaid) {
      throw new AccountPayablePaymentRequiredError();
    }

    const timeZone =
      (findBusiness as { timezone?: string | null }).timezone ?? "";

    if (accountPayableData.due_date) {
      accountPayableData.due_date = billDateFromInput(
        accountPayableData.due_date,
        timeZone,
      );
    }

    if (accountPayableData.payment_date) {
      accountPayableData.payment_date = billDateFromInput(
        accountPayableData.payment_date,
        timeZone,
      );
    }

    // Only a hand-over pages someone: an update that keeps the responsible
    // publishes with no recipient and feeds the activity trail alone.
    const registrationUserChanged =
      accountPayableData.registrationUserId !== undefined &&
      findAccountPayable.registrationUserId !==
        accountPayableData.registrationUserId;

    let updatedAccountPayable: AccountPayable;

    try {
      updatedAccountPayable = await database.$transaction(async (tx) => {
        const updated = await this.accountPayable.updateAccountPayable(
          { accountPayableData, accountPayableId },
          tx,
        );

        await this.outbox.publish(tx, {
          topic: "account-payable.updated",
          aggregateType: "account-payable",
          aggregateId: updated.id,
          businessId,
          actorId: userId,
          payload: {
            accountPayableId: updated.id,
            businessId,
            amount: Number(updated.amount),
            serviceOrderId: (updated.serviceOrderId as string) || null,
            registrationUserId:
              registrationUserChanged && accountPayableData.registrationUserId
                ? accountPayableData.registrationUserId
                : null,
          },
        });

        return updated;
      });
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar a conta a pagar! Por favor, tente novamente.",
        500,
      );
    }

    const warnings: string[] = [];
    const serviceOrderId = updatedAccountPayable.serviceOrderId;

    // Re-checked when the link or the amount changed.
    if (
      serviceOrderId &&
      (accountPayableData.serviceOrderId || accountPayableData.amount)
    ) {
      const order =
        serviceOrder ??
        (await this.serviceOrder.findServiceOrderById(serviceOrderId));

      const overrun = order
        ? serviceOrderOverrunWarning(
            await this.accountPayable.sumAmountByServiceOrderId(serviceOrderId),
            (order as { total_amount: unknown }).total_amount,
          )
        : null;

      if (overrun) warnings.push(overrun);
    }

    return { ...updatedAccountPayable, warnings };
  }
}

export { UpdateAccountPayableUseCase };
export type { UpdatedAccountPayable };
