import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IOccurrenceTypeRepository } from "../../repositories/IOccurrence-type-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { OccurrenceTypeNameAlreadyExistsError } from "../errors/occurrence-type-errors";
import { AppError } from "@/shared/errors/AppError";

import {
  OccurrenceType,
  CreateOccurrenceTypeProps,
} from "../../dtos/occurrence-type-dto";

@injectable()
class CreateOccurrenceTypeUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("OccurrenceTypeRepository")
    private occurrenceType: IOccurrenceTypeRepository,
  ) {}

  async execute(
    occurrenceTypeData: CreateOccurrenceTypeProps,
    userId: string,
  ): Promise<OccurrenceType> {
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

    const findBusiness = await this.business.findBusinessById(
      occurrenceTypeData.businessId,
    );

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    const findByName = await this.occurrenceType.findOccurrenceTypeByName(
      occurrenceTypeData.businessId,
      occurrenceTypeData.name,
    );

    if (findByName) {
      throw new OccurrenceTypeNameAlreadyExistsError();
    }

    try {
      return await this.occurrenceType.createOccurrenceType(
        occurrenceTypeData,
      );
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o tipo de ocorrência! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateOccurrenceTypeUseCase };
