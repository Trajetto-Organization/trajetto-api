import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IStatusChangeReasonRepository } from "../../repositories/IStatus-change-reason-repository";

import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { StatusChangeReasonNameAlreadyExistsError } from "../errors/status-change-reason-errors";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";

import { AppError } from "@/shared/errors/AppError";

import {
  StatusChangeReason,
  CreateStatusChangeReasonProps,
} from "../../dtos/status-change-reason-dto";

import {
  businessNotFound,
  callerNotFound,
} from "@/shared/delivery/caller-not-found";
import { sendCatalogChangedEvent } from "@/websocket";

/**
 * A word the company adds to its own vocabulary for overriding a status.
 *
 * The catalogue is what turns "por quê?" into something support can group and
 * count. Free text would answer the question once and never again.
 */
@injectable()
class CreateStatusChangeReasonUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("StatusChangeReasonRepository")
    private reason: IStatusChangeReasonRepository,
  ) {}

  async execute(
    reasonData: CreateStatusChangeReasonProps,
    userId: string,
  ): Promise<StatusChangeReason> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // Vocabulary is the dispatcher's to define, not the driver's.
    assertDispatcher(findUser);

    const findBusiness = await this.business.findBusinessById(
      reasonData.businessId,
    );

    if (!findBusiness) {
      throw businessNotFound();
    }

    const findByName = await this.reason.findStatusChangeReasonByName(
      reasonData.businessId,
      reasonData.name,
    );

    if (findByName) {
      throw new StatusChangeReasonNameAlreadyExistsError();
    }

    let created: Awaited<
      ReturnType<IStatusChangeReasonRepository["createStatusChangeReason"]>
    >;

    try {
      created = await this.reason.createStatusChangeReason(reasonData);
    } catch (error) {
      // A twin request committed between the check and the write: the unique
      // index decided, and the answer is the check's 409.
      if (violatesUniqueOn(error, "name")) {
        throw new StatusChangeReasonNameAlreadyExistsError();
      }

      throw new AppError(
        "Houve um erro ao tentar criar o motivo! Por favor, tente novamente.",
        500,
      );
    }

    // After the write: open "Mudar status" pickers refetch.
    sendCatalogChangedEvent(reasonData.businessId, "status_reason");

    return created;
  }
}

export { CreateStatusChangeReasonUseCase };
