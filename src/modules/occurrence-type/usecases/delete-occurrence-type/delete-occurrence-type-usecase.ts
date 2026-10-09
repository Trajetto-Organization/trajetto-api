import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IOccurrenceTypeRepository } from "../../repositories/IOccurrence-type-repository";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import {
  OccurrenceTypeDefaultError,
  OccurrenceTypeNotFoundError,
  OccurrenceTypeInUseError,
  OccurrenceTypeSystemError,
} from "../errors/occurrence-type-errors";

import { AppError } from "@/shared/errors/AppError";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { sendCatalogChangedEvent } from "@/websocket";

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
      throw callerNotFound();
    }

    // The operation's catalogue belongs to the dispatcher. `delivery_manage`
    // and `occurrence_manage` are open to the driver on purpose (the app runs
    // on them), so the permission table says yes and the use case says no.
    assertDispatcher(findUser);

    const findOccurrenceType =
      await this.occurrenceType.findOccurrenceTypeById(occurrenceTypeId);

    // Another company's id reads as absent (decision 11.3): a separate
    // "not yours" answer told a caller which ids exist elsewhere.
    if (!findOccurrenceType || findOccurrenceType.businessId !== businessId) {
      throw new OccurrenceTypeNotFoundError();
    }

    // The rejections already recorded are named by it (DLVP-OCC-3).
    if (findOccurrenceType.is_system) {
      throw new OccurrenceTypeSystemError();
    }

    // The legacy adapters find the seeded defaults by key (decision 14.3):
    // an installed app proving or pausing would have nothing to land on.
    if (findOccurrenceType.system_key != null) {
      throw new OccurrenceTypeDefaultError();
    }

    // Occurrence and pause history references the type — a used type is deactivated,
    // never deleted (the trail must keep naming what happened). EXISTS, not
    // a count: a delivered type is named by every proof of the company.
    if (await this.occurrenceType.isOccurrenceTypeInUse(occurrenceTypeId)) {
      throw new OccurrenceTypeInUseError(
        "Existem registros de ocorrência ou pausa com ele.",
      );
    }

    // Deleting the last active delivery (or pause) type is as fatal as
    // deactivating it: the driver could no longer prove (or pause).
    const category = findOccurrenceType.category;
    const keepOneActiveOf =
      findOccurrenceType.is_active !== false &&
      (category === "DELIVERED" || category === "PAUSE")
        ? category
        : undefined;

    try {
      await this.occurrenceType.deleteOccurrenceType(occurrenceTypeId, {
        keepOneActiveOf,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar excluir o tipo de ocorrência! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(businessId, "occurrence_type");
  }
}

export { DeleteOccurrenceTypeUseCase };
