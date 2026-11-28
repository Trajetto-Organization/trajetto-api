import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IAccountPayableRepository } from "../../repositories/IAccount-payable-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { AccountPayableNotFoundError } from "../errors/account-payable-not-found-error";

import {
  decidePermission,
  type PermissionPrincipal,
} from "@/modules/middlewares/verify-permission";
import { resolveRequestedCompany } from "@/modules/middlewares/tenant-authorization";

import { AccountPayable } from "../../dtos/account-payable-dto";
import {
  businessClockOf,
  withSituation,
  type AccountPayableSituation,
} from "../../rules/account-payable-status";

/** The bill with its money as numbers and the situation of the lists. */
type AccountPayableRead = Omit<AccountPayable, "amount" | "amount_paid"> & {
  amount: number;
  amount_paid: number | null;
} & AccountPayableSituation;

interface GetAccountPayableRequest {
  userId: string;
  accountPayableId: string;
  /** The MASTER's selected company; anyone else reads their own. */
  businessId?: string;
}

/**
 * One bill by its id (wave 3): what the "nova conta a pagar" notification
 * opens in the app. Same reach as the two listings together: the company's
 * admin, a profile with `account_payable_manage:read` and the MASTER in the
 * company he selected read any bill of the company; anyone else — the
 * driver included — only a bill whose responsible they are, like
 * "minhas contas" (decision 4.5). The driver map never opens the key, so a
 * driver reaches only his own.
 *
 * Out of reach answers 404 ACCOUNT_PAYABLE_NOT_FOUND, the body of an id
 * that exists nowhere (decision 11.3). The bill leaves with the situation
 * the lists compute, by the company's business day.
 */
@injectable()
class GetAccountPayableUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("AccountPayableRepository")
    private accountPayable: IAccountPayableRepository,
  ) {}

  async execute({
    userId,
    accountPayableId,
    businessId,
  }: GetAccountPayableRequest): Promise<AccountPayableRead> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const companyId = resolveRequestedCompany(findUser, businessId);

    const bill =
      await this.accountPayable.findAccountPayableById(accountPayableId);

    if (!bill || bill.businessId !== companyId) {
      throw new AccountPayableNotFoundError();
    }

    const readsTheCompany =
      decidePermission(
        findUser as unknown as PermissionPrincipal,
        "account_payable_manage",
        "read",
        { allowDriver: false },
      ) === null;

    if (!readsTheCompany && bill.registrationUserId !== findUser.id) {
      throw new AccountPayableNotFoundError();
    }

    const clock = businessClockOf(
      await this.business.findBusinessById(companyId),
    );

    // Decimal columns leave as numbers: this body goes through the response
    // schema, not through the NDJSON stream that converts them.
    return withSituation(
      {
        ...bill,
        amount: Number(bill.amount),
        amount_paid:
          bill.amount_paid === null || bill.amount_paid === undefined
            ? null
            : Number(bill.amount_paid),
      },
      clock,
    );
  }
}

export { GetAccountPayableUseCase };
export type { AccountPayableRead };
