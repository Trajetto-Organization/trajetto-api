import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { IAccountPayableRepository } from "../../repositories/IAccount-payable-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { AccountPayable } from "../../dtos/account-payable-dto";
import { AppError } from "@/shared/errors/AppError";

import {
  businessClockOf,
  withSituation,
  type AccountPayableSituation,
} from "../../rules/account-payable-status";

interface SearchAccountPayableCursorRequest {
  userId: string;
  limit?: number;
  cursor?: string;
  search?: string;
}

interface SearchAccountPayableCursorResponse {
  data: Array<AccountPayable & AccountPayableSituation>;
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * "Minhas contas a pagar": the bills the signed-in user is RESPONSIBLE for,
 * in their own company (decision 4.5).
 *
 * Self-scoped by construction — the user id and the company come from the
 * session, never from the request — so it needs no profile permission: a
 * driver can be the responsible for a bill (a fine to discount, a trip
 * advance), is notified with its amount and a link here, and used to get a
 * 403 on arrival. The company-wide list stays behind account_payable_manage.
 */
@injectable()
class SearchAccountPayableCursorUseCase {
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
    limit = 10,
    cursor,
    search,
  }: SearchAccountPayableCursorRequest): Promise<SearchAccountPayableCursorResponse> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    // A MASTER belongs to no company and answers for no bill.
    if (!findUser.businessId) {
      return { data: [], nextCursor: null, hasMore: false };
    }

    try {
      const result =
        await this.accountPayable.searchAccountPayableByResponsibleUserWithCursor(
          {
            limit,
            cursor,
            businessId: findUser.businessId,
            userId,
            search,
          },
        );

      // The status is the company's, like on the manager's list.
      const clock = businessClockOf(
        await this.business.findBusinessById(findUser.businessId),
      );

      return {
        ...result,
        data: result.data.map((bill) => withSituation(bill, clock)),
      };
    } catch (error) {
      throw new AppError(
        "Não foi possível recuperar a lista de contas a pagar!",
        500,
      );
    }
  }
}

export { SearchAccountPayableCursorUseCase };
