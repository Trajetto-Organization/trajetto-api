import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IOccurrenceTypeRepository } from "../../repositories/IOccurrence-type-repository";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import {
  categoryValidationError,
  OccurrenceTypeCategoryLockedError,
  OccurrenceTypeNotFoundError,
  OccurrenceTypeNameAlreadyExistsError,
  OccurrenceTypeSystemError,
} from "../errors/occurrence-type-errors";
import { categoryIssues } from "../../rules/occurrence-category-rules";
import { categoryShapeOf } from "../category-shape";

import { AppError } from "@/shared/errors/AppError";
import {
  OccurrenceType,
  UpdateOccurrenceTypeProps,
} from "../../dtos/occurrence-type-dto";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";
import { sendCatalogChangedEvent } from "@/websocket";
import {
  normalizeFormFields,
  readFormFields,
  sameFormFields,
} from "../../form/occurrence-form-rules";

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

    // The platform's own type (DLVP-OCC-3) is not the company's to reshape.
    if (findOccurrenceType.is_system) {
      throw new OccurrenceTypeSystemError();
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

    // The form moves form_version only when it really changed: saving the
    // same questions again (the dialog always sends them) must not make every
    // report filed against the old number look outdated.
    const { form_fields: requestedForm, ...otherChanges } = occurrenceTypeData;

    const nextForm =
      requestedForm === undefined
        ? undefined
        : normalizeFormFields(requestedForm);

    const formChanged =
      nextForm !== undefined &&
      !sameFormFields(readFormFields(findOccurrenceType.form_fields), nextForm);

    const currentCategory = findOccurrenceType.category ?? "NOT_DELIVERED";
    const nextCategory = otherChanges.category ?? currentCategory;

    // Leaving PAUSE drops the nature with it (the CHECK pairs the two).
    if (nextCategory !== "PAUSE" && findOccurrenceType.pause_kind != null) {
      otherChanges.pause_kind ??= null;
    }

    const categoryMoves = nextCategory !== currentCategory;
    const kindMoves =
      otherChanges.pause_kind !== undefined &&
      (otherChanges.pause_kind ?? null) !==
        (findOccurrenceType.pause_kind ?? null) &&
      // Dropped along with a category change: judged by that change.
      !(categoryMoves && otherChanges.pause_kind === null);

    // Decision 14.3: what a used or seeded type meant stays what it means.
    if (
      (categoryMoves || kindMoves) &&
      (findOccurrenceType.system_key != null ||
        (await this.occurrenceType.isOccurrenceTypeInUse(occurrenceTypeId)))
    ) {
      throw new OccurrenceTypeCategoryLockedError();
    }

    const issues = categoryIssues(
      categoryShapeOf(
        findOccurrenceType,
        otherChanges,
        formChanged ? nextForm : undefined,
      ),
    );

    if (issues.length > 0) throw categoryValidationError(issues);

    // The flag and its instant move together: an offline delivery tapped
    // before deactivated_at is still accepted (design §5.6).
    const wasActive = findOccurrenceType.is_active !== false;
    const willBeActive = otherChanges.is_active ?? wasActive;

    if (wasActive !== willBeActive) {
      otherChanges.deactivated_at = willBeActive ? null : new Date();
    }

    // The company keeps one active delivery type and one active pause type:
    // without them the driver cannot prove or pause at all.
    const leavesCategory =
      wasActive && (!willBeActive || categoryMoves) ? currentCategory : null;

    const keepOneActiveOf =
      leavesCategory === "DELIVERED" || leavesCategory === "PAUSE"
        ? leavesCategory
        : undefined;

    let updated: Awaited<
      ReturnType<IOccurrenceTypeRepository["updateOccurrenceType"]>
    >;

    try {
      updated = await this.occurrenceType.updateOccurrenceType(
        occurrenceTypeId,
        {
          ...otherChanges,
          ...(formChanged && { form_fields: nextForm }),
        },
        { keepOneActiveOf },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;

      // A twin rename committed between the check and the write: the unique
      // index decided, and the answer is the check's.
      if (violatesUniqueOn(error, "name")) {
        throw new OccurrenceTypeNameAlreadyExistsError();
      }

      throw new AppError(
        "Houve um erro ao tentar atualizar o tipo de ocorrência! Por favor, tente novamente.",
        500,
      );
    }

    sendCatalogChangedEvent(businessId, "occurrence_type");

    return updated;
  }
}

export { UpdateOccurrenceTypeUseCase };
