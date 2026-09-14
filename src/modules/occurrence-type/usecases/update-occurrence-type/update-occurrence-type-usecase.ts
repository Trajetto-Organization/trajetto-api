import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IOccurrenceTypeRepository } from "../../repositories/IOccurrence-type-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  OccurrenceTypeNotFoundError,
  OccurrenceTypeNameAlreadyExistsError,
  OccurrenceTypeNotBelongBusinessError,
} from "../errors/occurrence-type-errors";

import { AppError } from "@/shared/errors/AppError";
import {
  OccurrenceType,
  UpdateOccurrenceTypeProps,
} from "../../dtos/occurrence-type-dto";

interface UpdateOccurrenceTypeRequest {
  userId: string;
  businessId: string;
  occurrenceTypeId: string;
  occurrenceTypeData: UpdateOccurrenceTypeProps;
}

@injectable()
class UpdateOccurrenceTypeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OccurrenceTypeRepository")
    private occurrenceType: IOccurrenceTypeRepository,
  ) {}

  async execute({
    userId,
    businessId,
    occurrenceTypeId,
    occurrenceTypeData,
  }: UpdateOccurrenceTypeRequest): Promise<OccurrenceType> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findOccurrenceType =
      await this.occurrenceType.findOccurrenceTypeById(occurrenceTypeId);

    if (!findOccurrenceType) {
      throw new OccurrenceTypeNotFoundError();
    }

    if (findOccurrenceType.businessId !== businessId) {
      throw new OccurrenceTypeNotBelongBusinessError();
    }

    if (
      occurrenceTypeData.name &&
      occurrenceTypeData.name !== findOccurrenceType.name
    ) {
      const findByName = await this.occurrenceType.findOccurrenceTypeByName(
        businessId,
        occurrenceTypeData.name,
      );

      if (findByName && findByName.id !== occurrenceTypeId) {
        throw new OccurrenceTypeNameAlreadyExistsError();
      }
    }

    try {
      return await this.occurrenceType.updateOccurrenceType(
        occurrenceTypeId,
        occurrenceTypeData,
      );
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o tipo de ocorrência! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateOccurrenceTypeUseCase };
