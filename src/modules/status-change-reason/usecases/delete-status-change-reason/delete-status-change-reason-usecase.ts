import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IStatusChangeReasonRepository } from "../../repositories/IStatus-change-reason-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";

import {
  StatusChangeReasonInUseError,
  StatusChangeReasonNotBelongBusinessError,
  StatusChangeReasonNotFoundError,
} from "../errors/status-change-reason-errors";

import { AppError } from "@/shared/errors/AppError";
import { StatusChangeReason } from "../../dtos/status-change-reason-dto";

/**
 * Removing a word from the company's vocabulary.
 *
 * Only a word nobody ever used. A reason already cited by an event is part of
 * the answer support gives about a decision somebody made; deleting it would
 * leave "status alterado — motivo: (nada)". The foreign key is ON DELETE
 * RESTRICT, so Postgres refuses too — this guard exists to make the refusal a
 * sentence with a number instead of a 500, and to point at deactivating.
 */
@injectable()
class DeleteStatusChangeReasonUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("StatusChangeReasonRepository")
    private reason: IStatusChangeReasonRepository,
  ) {}

  async execute(
    reasonId: string,
    businessId: string,
    userId: string,
  ): Promise<StatusChangeReason> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    assertDispatcher(findUser);

    const findReason = await this.reason.findStatusChangeReasonById(reasonId);

    if (!findReason) {
      throw new StatusChangeReasonNotFoundError();
    }

    if (findReason.businessId !== businessId) {
      throw new StatusChangeReasonNotBelongBusinessError();
    }

    const citedBy = await this.reason.countEventsByReasonId(reasonId);

    if (citedBy > 0) {
      throw new StatusChangeReasonInUseError(citedBy);
    }

    try {
      return await this.reason.deleteStatusChangeReason(reasonId);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar excluir o motivo! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteStatusChangeReasonUseCase };
