import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IStatusChangeReasonRepository } from "../../repositories/IStatus-change-reason-repository";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";

import {
  StatusChangeReasonNameAlreadyExistsError,
  StatusChangeReasonNotFoundError,
} from "../errors/status-change-reason-errors";

import { AppError } from "@/shared/errors/AppError";

import {
  StatusChangeReason,
  UpdateStatusChangeReasonProps,
} from "../../dtos/status-change-reason-dto";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";
import { sendCatalogChangedEvent } from "@/websocket";

@injectable()
class UpdateStatusChangeReasonUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("StatusChangeReasonRepository")
    private reason: IStatusChangeReasonRepository,
  ) {}

  async execute(
    reasonData: UpdateStatusChangeReasonProps,
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

    if (reasonData.name && reasonData.name !== findReason.name) {
      const findByName = await this.reason.findStatusChangeReasonByName(
        businessId,
        reasonData.name,
      );

      if (findByName) {
        throw new StatusChangeReasonNameAlreadyExistsError();
      }
    }

    let updated: Awaited<
      ReturnType<IStatusChangeReasonRepository["updateStatusChangeReason"]>
    >;

    try {
      updated = await this.reason.updateStatusChangeReason(
        reasonId,
        reasonData,
      );
    } catch (error) {
      // A twin request committed between the check and the write: the unique
      // index decided, and the answer is the check's 409.
      if (violatesUniqueOn(error, "name")) {
        throw new StatusChangeReasonNameAlreadyExistsError();
      }

      throw new AppError(
        "Houve um erro ao tentar editar o motivo! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(businessId, "status_reason");

    return updated;
  }
}

export { UpdateStatusChangeReasonUseCase };
