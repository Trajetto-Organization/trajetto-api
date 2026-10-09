import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IStatusChangeReasonRepository } from "../../repositories/IStatus-change-reason-repository";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";

import {
  StatusChangeReasonInUseError,
  StatusChangeReasonNotFoundError,
} from "../errors/status-change-reason-errors";

import { AppError } from "@/shared/errors/AppError";
import { StatusChangeReason } from "../../dtos/status-change-reason-dto";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { sendCatalogChangedEvent } from "@/websocket";

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
      throw callerNotFound();
    }

    assertDispatcher(findUser);

    const findReason = await this.reason.findStatusChangeReasonById(reasonId);

    // Another company's id reads as absent (decision 11.3): a separate
    // "not yours" answer told a caller which ids exist elsewhere.
    if (!findReason || findReason.businessId !== businessId) {
      throw new StatusChangeReasonNotFoundError();
    }

    const citedBy = await this.reason.countEventsByReasonId(reasonId);

    if (citedBy > 0) {
      throw new StatusChangeReasonInUseError(citedBy);
    }

    let deleted: Awaited<
      ReturnType<IStatusChangeReasonRepository["deleteStatusChangeReason"]>
    >;

    try {
      deleted = await this.reason.deleteStatusChangeReason(reasonId);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar excluir o motivo! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(businessId, "status_reason");

    return deleted;
  }
}

export { DeleteStatusChangeReasonUseCase };
