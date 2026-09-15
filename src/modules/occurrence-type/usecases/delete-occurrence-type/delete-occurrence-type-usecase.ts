import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IOccurrenceTypeRepository } from "../../repositories/IOccurrence-type-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import {
  OccurrenceTypeNotFoundError,
  OccurrenceTypeNotBelongBusinessError,
  OccurrenceTypeInUseError,
} from "../errors/occurrence-type-errors";

import { AppError } from "@/shared/errors/AppError";

interface DeleteOccurrenceTypeRequest {
  userId: string;
  businessId: string;
  occurrenceTypeId: string;
}

@injectable()
class DeleteOccurrenceTypeUseCase {
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
  }: DeleteOccurrenceTypeRequest): Promise<void> {
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

    // Occurrence history references the type — a used type is deactivated,
    // never deleted (the trail must keep naming what happened).
    const occurrenceCount =
      await this.occurrenceType.countOccurrencesByTypeId(occurrenceTypeId);

    if (occurrenceCount > 0) {
      throw new OccurrenceTypeInUseError(
        `Existem ${occurrenceCount} ocorrência(s) registrada(s) com ele.`,
      );
    }

    try {
      await this.occurrenceType.deleteOccurrenceType(occurrenceTypeId);
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar excluir o tipo de ocorrência! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { DeleteOccurrenceTypeUseCase };
