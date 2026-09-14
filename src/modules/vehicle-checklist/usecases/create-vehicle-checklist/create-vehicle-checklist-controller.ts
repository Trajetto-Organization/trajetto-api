import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { CreateVehicleChecklistUseCase } from "./create-vehicle-checklist-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";

import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { presignedPhotosSchema } from "@/schemas/presigned-photos-schema";

import { createVehicleChecklistSchema } from "@/schemas/create-vehicle-checklist-schema";

import { PhotoValidationService } from "@/shared/services/photo-validation-service";
import { normalizeFormFields } from "@/shared/utils/normalize-form-field";

class CreateVehicleChecklistController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const { photos, ...fields } = body;

    // The photos are already in storage; only their keys travel here. Nothing
    // to drain, nothing to buffer, nothing that can stall halfway through
    // twenty camera photos.
    const formData: Record<string, any> = normalizeFormFields(fields);
    const presignedPhotos = presignedPhotosSchema.parse(photos);

    // Grouped by field so the existing required-photo validation keeps working
    // unchanged: it only asks whether a field has photos, not what they are.
    const photosByField: Record<string, any[]> = {};

    for (const photo of presignedPhotos ?? []) {
      if (!photo.fieldName) continue;

      photosByField[photo.fieldName] ??= [];
      photosByField[photo.fieldName].push(photo);
    }

    const idempotencyKey = request.headers["idempotency-key"];
    if (!formData.client_submission_id && typeof idempotencyKey === "string") {
      formData.client_submission_id = idempotencyKey;
    }

    let checklistData: any;

    try {
      checklistData = createVehicleChecklistSchema.parse(formData);
    } catch (error) {
      return reply.status(400).send({
        message: "Dados do formulário inválidos",
        details: error instanceof Error ? error.message : "Erro de validação",
      });
    }

    const photoValidation =
      PhotoValidationService.validateRequiredPhotosProvided(
        checklistData,
        photosByField,
      );

    if (!photoValidation.isValid) {
      return reply.status(400).send({
        message: "Fotos obrigatórias não fornecidas",
        errors: photoValidation.errors,
        missingPhotos: photoValidation.missingPhotos,
        photoRequirements:
          PhotoValidationService.validatePhotosRequired(checklistData),
      });
    }

    const createVehicleChecklistUseCase = container.resolve(
      CreateVehicleChecklistUseCase,
    );

    try {
      const checklist = await createVehicleChecklistUseCase.execute(
        {
          ...checklistData,
          businessId,
        },
        id,
        presignedPhotos,
      );

      return reply
        .header(
          "Idempotency-Key",
          checklistData.client_submission_id ?? "not-provided",
        )
        .status(201)
        .send({
          message: "Checklist veicular criado com sucesso!",
          id: checklist.id,
        });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotBelongBusinessError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNotBelongBusinessError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNotBelongBusinessError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleMileageInvalidError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotAssignedToDriverError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateVehicleChecklistController };
