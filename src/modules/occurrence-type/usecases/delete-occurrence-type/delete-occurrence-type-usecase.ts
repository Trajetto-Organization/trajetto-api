import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IOccurrenceTypeRepository } from "../../repositories/IOccurrence-type-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
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
