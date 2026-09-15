import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IStatusChangeReasonRepository } from "../../repositories/IStatus-change-reason-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";

import {
  StatusChangeReasonNameAlreadyExistsError,
  StatusChangeReasonNotBelongBusinessError,
  StatusChangeReasonNotFoundError,
} from "../errors/status-change-reason-errors";

import { AppError } from "@/shared/errors/AppError";

import {
  StatusChangeReason,
  UpdateStatusChangeReasonProps,
} from "../../dtos/status-change-reason-dto";

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

    if (reasonData.name && reasonData.name !== findReason.name) {
      const findByName = await this.reason.findStatusChangeReasonByName(
        businessId,
        reasonData.name,
      );

      if (findByName) {
        throw new StatusChangeReasonNameAlreadyExistsError();
      }
    }

    try {
      return await this.reason.updateStatusChangeReason(reasonId, reasonData);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar editar o motivo! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateStatusChangeReasonUseCase };
