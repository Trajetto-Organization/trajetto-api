import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { UpdateVehicleChecklistUseCase } from "./update-vehicle-checklist-usecase";

import { replyChecklistError } from "../errors/vehicle-checklist-http-errors";

import { presignedPhotosSchema } from "@/schemas/presigned-photos-schema";
import { normalizeFormFields } from "@/shared/utils/normalize-form-field";

import { updateDeleteVehicleChecklistSchema } from "@/schemas/update-delete-vehicle-checklist-schema";
import { updateVehicleChecklistSchema } from "@/schemas/update-vehicle-checklist-schema";

import { VehicleChecklistRequiredPhotosMissingError } from "../errors/vehicle-checklist-required-photos-missing-error";

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
      return reply.header("x-error-code", "VALIDATION_ERROR").status(400).send({
        code: "VALIDATION_ERROR",
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
      // Foreign ids answer like unknown ones; every refusal carries a code
      // (vehicle-checklist-http-errors).
      if (replyChecklistError(reply, error)) return;

      if (error instanceof VehicleChecklistRequiredPhotosMissingError) {
        return reply.header("x-error-code", "PHOTOS_REQUIRED").status(400).send({
          code: "PHOTOS_REQUIRED",
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

      throw error;
    }
  }
}

export { UpdateVehicleChecklistController };
