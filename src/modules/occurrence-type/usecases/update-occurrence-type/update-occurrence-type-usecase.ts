import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IOccurrenceTypeRepository } from "../../repositories/IOccurrence-type-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
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

    // O catálogo da operação é do despachante. `delivery_manage` e
    // `occurrence_manage` são abertos ao motorista de propósito — o
    // aplicativo dele roda nessas permissões —, então a tabela de
    // permissões diz sim e a use case diz não. O módulo de motivos de
    // status, na MESMA chave, já fazia isto nas três escritas.
    assertDispatcher(findUser);

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
