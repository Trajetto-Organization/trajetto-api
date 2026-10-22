import { inject, injectable } from "tsyringe";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { IAccountPayableRepository } from "@/modules/account-payable/repositories/IAccount-payable-repository";

import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IBranchRepository } from "@/modules/branch/repositories/IBranch-repository";

import { IServiceOrderRepository } from "@/modules/service-order/repositories/IService-order-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ISupplierRepository } from "@/modules/supplier/repositories/ISupplier-repository";
import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { AccountPayableInvalidAmountError } from "../errors/account-payable-invalid-amount-error";

import {
  AccountPayable,
  CreateAccountPayableProps,
} from "../../dtos/account-payable-dto";

import { OutboxService } from "@/shared/notifications/outbox-service";

import { AppError } from "@/shared/errors/AppError";
import { isUniqueViolation } from "@/shared/http/idempotency-key";
import database from "@/../infra/database";

import { assertAccountPayableReferences } from "../account-payable-references";
import { billDateFromInput } from "../../rules/account-payable-status";

import { serviceOrderOverrunWarning } from "../../rules/service-order-overrun";

/** The bill, plus what the person should look at (never a refusal). */
type CreatedAccountPayable = AccountPayable & { warnings: string[] };

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
    @inject("SupplierRepository")
    private supplier: ISupplierRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
  ) {}

  async execute(
    accountPayableData: CreateAccountPayableProps,
    userId: string,
  ): Promise<CreatedAccountPayable> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // Defense in depth: the route guard must not be the only wall between tenants.
    assertTenantAccess(findUser, accountPayableData.businessId);

    const findBusiness = await this.business.findBusinessById(
      accountPayableData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    // The same form sent twice — a lost answer, a second click — is the bill
    // it already created, and notifies nobody again (IDEMP-14).
    const replay = await this.replayOf(accountPayableData);

    if (replay) return { ...replay, warnings: [] };

    // Branch, service order, payee, vehicle and the responsible person (who
    // is notified with the amount) all belong to this company.
    const { serviceOrder } = await assertAccountPayableReferences(
      {
        branch: this.branch,
        serviceOrder: this.serviceOrder,
        supplier: this.supplier,
        vehicle: this.vehicle,
        user: this.user,
      },
      accountPayableData.businessId,
      {
        branchId: accountPayableData.branchId,
        serviceOrderId: accountPayableData.serviceOrderId,
        supplierId: accountPayableData.supplierId,
        vehicleId: accountPayableData.vehicleId,
        registrationUserId: accountPayableData.registrationUserId,
      },
    );

    // Check that the amount paid is not greater than the total amount
    if (
      accountPayableData.amount_paid &&
      accountPayableData.amount_paid > accountPayableData.amount
    ) {
      throw new AccountPayableInvalidAmountError();
    }

    const timeZone = (findBusiness as { timezone?: string | null }).timezone;

    const data: CreateAccountPayableProps = {
      ...accountPayableData,
      // A picked DAY is stored as the instant it starts in the company's
      // zone: the status is then decided by that zone's calendar.
      due_date: billDateFromInput(accountPayableData.due_date, timeZone ?? ""),
      payment_date: accountPayableData.payment_date
        ? billDateFromInput(accountPayableData.payment_date, timeZone ?? "")
        : null,
      // A registered supplier IS the payee; free text is for the rest.
      payee_name: accountPayableData.supplierId
        ? null
        : (accountPayableData.payee_name ?? null),
      // Who typed it, from the session — never from the body (decision 8.4).
      createdById: userId,
    };

    let accountPayableCreated: AccountPayable;

    try {
      // Bill and outbox event commit together; the pipeline notifies the
      // responsible user and records the activity after the commit.
      accountPayableCreated = await database.$transaction(async (tx) => {
        const created = await this.accountPayable.createAccountPayable(
          data,
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
    } catch (error) {
      // The twin of this submission committed after the replay check: the
      // insert met the unique key, and the twin's bill is the answer.
      if (isUniqueViolation(error)) {
        const replay = await this.replayOf(accountPayableData);

        if (replay) return { ...replay, warnings: [] };
      }

      throw new AppError(
        "Houve um erro ao tentar criar a conta a pagar! Por favor, tente novamente.",
        500,
      );
    }

    const warnings: string[] = [];

    if (serviceOrder && accountPayableData.serviceOrderId) {
      const overrun = serviceOrderOverrunWarning(
        await this.accountPayable.sumAmountByServiceOrderId(
          accountPayableData.serviceOrderId,
        ),
        serviceOrder.total_amount,
      );

      if (overrun) warnings.push(overrun);
    }

    return { ...accountPayableCreated, warnings };
  }

  private async replayOf(
    accountPayableData: CreateAccountPayableProps,
  ): Promise<AccountPayable | null> {
    if (!accountPayableData.client_submission_id) return null;

    return this.accountPayable.findAccountPayableBySubmissionId(
      accountPayableData.businessId,
      accountPayableData.client_submission_id,
    );
  }
}

export { CreateAccountPayableUseCase };
export type { CreatedAccountPayable };
