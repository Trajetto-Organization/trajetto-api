import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IOccurrenceTypeRepository } from "../../repositories/IOccurrence-type-repository";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";

import {
  categoryValidationError,
  OccurrenceTypeNameAlreadyExistsError,
} from "../errors/occurrence-type-errors";
import { categoryIssues } from "../../rules/occurrence-category-rules";
import { categoryShapeOf } from "../category-shape";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";
import { AppError } from "@/shared/errors/AppError";

import {
  OccurrenceType,
  CreateOccurrenceTypeProps,
} from "../../dtos/occurrence-type-dto";

import {
  businessNotFound,
  callerNotFound,
} from "@/shared/delivery/caller-not-found";
import { sendCatalogChangedEvent } from "@/websocket";
import { normalizeFormFields } from "../../form/occurrence-form-rules";

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
      throw callerNotFound();
    }

    // The operation's catalogue belongs to the dispatcher. `delivery_manage`
    // and `occurrence_manage` are open to the driver on purpose (the app runs
    // on them), so the permission table says yes and the use case says no.
    assertDispatcher(findUser);

    const findBusiness = await this.business.findBusinessById(
      occurrenceTypeData.businessId,
    );

    if (!findBusiness) {
      throw businessNotFound();
    }

    const findByName = await this.occurrenceType.findOccurrenceTypeByName(
      occurrenceTypeData.businessId,
      occurrenceTypeData.name,
    );

    if (findByName) {
      throw new OccurrenceTypeNameAlreadyExistsError();
    }

    const formFields = normalizeFormFields(occurrenceTypeData.form_fields);

    // Decision 14.3: what each category may ask. Checked here so a bad
    // combination is a 400 with sentences, not the CHECK's 500.
    const issues = categoryIssues(
      categoryShapeOf({}, occurrenceTypeData, formFields),
    );

    if (issues.length > 0) throw categoryValidationError(issues);

    let created: Awaited<
      ReturnType<IOccurrenceTypeRepository["createOccurrenceType"]>
    >;

    try {
      created = await this.occurrenceType.createOccurrenceType({
        ...occurrenceTypeData,
        // Stored in one canonical shape, so an edit that sends the same form
        // back is recognised as "unchanged" and does not move form_version.
        form_fields: formFields,
        // Only PAUSE carries a nature (CHECK occurrence_type_pause_kind_chk).
        pause_kind:
          occurrenceTypeData.category === "PAUSE"
            ? (occurrenceTypeData.pause_kind ?? null)
            : null,
      });
    } catch (error) {
      // A twin request committed between the check and the write: the unique
      // index decided, and the answer is the check's 409.
      if (violatesUniqueOn(error, "name")) {
        throw new OccurrenceTypeNameAlreadyExistsError();
      }

      throw new AppError(
        "Houve um erro ao tentar criar o tipo de ocorrência! Por favor, tente novamente.",
        500,
      );
    }

    // After the write: open "Registrar ocorrência" pickers refetch.
    sendCatalogChangedEvent(occurrenceTypeData.businessId, "occurrence_type");

    return created;
  }
}

export { CreateOccurrenceTypeUseCase };
