import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { UpdateVehicleChecklistUseCase } from "./update-vehicle-checklist-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { VehicleMileageInvalidError } from "@/modules/vehicle/usecases/errors/vehicle-mileage-invalid-error";

import { VehicleChecklistDriverCannotUpdateChecklistError } from "../errors/vehicle-checklist-driver-cannot-update-checklist-error";

import { presignedPhotosSchema } from "@/schemas/presigned-photos-schema";
import { normalizeFormFields } from "@/shared/utils/normalize-form-field";

import { updateDeleteVehicleChecklistSchema } from "@/schemas/update-delete-vehicle-checklist-schema";
import { updateVehicleChecklistSchema } from "@/schemas/update-vehicle-checklist-schema";

import { VehicleChecklistRequiredPhotosMissingError } from "../errors/vehicle-checklist-required-photos-missing-error";
import { VehicleChecklistBusinessNotFoundError } from "../errors/vehicle-checklist-business-not-found-error";

import { PhotoValidationService } from "@/shared/services/photo-validation-service";

class UpdateVehicleChecklistController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { checklistId, businessId } =
      updateDeleteVehicleChecklistSchema.parse(request.params);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const { photos, ...fields } = body;

    // Same shape as the create endpoint: the files are already in storage and
    // only their keys arrive here.
    const formData: Record<string, any> = normalizeFormFields(fields);
    const presignedPhotos = presignedPhotosSchema.parse(photos);

    const photosByField: Record<string, any[]> = {};

    for (const photo of presignedPhotos ?? []) {
      if (!photo.fieldName) continue;

      photosByField[photo.fieldName] ??= [];
      photosByField[photo.fieldName].push(photo);
    }

    let checklistData: any;

    try {
      checklistData = updateVehicleChecklistSchema.parse(formData);
    } catch (error) {
      return reply.status(400).send({
        message: "Dados do formulário inválidos",
        details: error instanceof Error ? error.message : "Erro de validação",
      });
    }

    // Photos the edit is dropping, sent as an array of stored URLs.
    const photosToRemove: string[] = Array.isArray(formData.photosToRemove)
      ? formData.photosToRemove
      : [];

    const updateVehicleChecklistUseCase = container.resolve(
      UpdateVehicleChecklistUseCase,
    );

    try {
      await updateVehicleChecklistUseCase.execute(
        checklistData,
        id,
        checklistId,
        businessId,
        photosByField,
        photosToRemove,
        presignedPhotos,
      );

      return reply
        .status(200)
        .send({ message: "Checklist veicular atualizado com sucesso!" });
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

      if (error instanceof VehicleChecklistDriverCannotUpdateChecklistError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleChecklistRequiredPhotosMissingError) {
        return reply.status(400).send({
          message: error.message,
          errors: error.errors,
          missingPhotos: error.missingPhotos,
          photoRequirements:
            PhotoValidationService.validatePhotosRequired(checklistData),
          fieldsSent: error.fieldsSent,
          photosSent: error.photosSent,
          existingPhotos: error.existingPhotos,
          photosToRemove: error.photosToRemove,
        });
      }

      if (error instanceof VehicleChecklistBusinessNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateVehicleChecklistController };
