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
import { readMultipartFile } from "@/shared/utils/read-multipart-file";

import { AppError } from "@/shared/errors/AppError";

const MAX_CHECKLIST_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_CHECKLIST_FILES = 20;

class UpdateVehicleChecklistController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { checklistId, businessId } =
      updateDeleteVehicleChecklistSchema.parse(request.params);

    const formData: Record<string, any> = {};
    const photosByField: Record<string, any[]> = {};

    let totalSize = 0;
    let fileCount = 0;

    let presignedPhotos: { key: string; fieldName?: string }[] | undefined;

    // Same dual shape as the create endpoint: multipart streams the files
    // through here, JSON carries only the keys of files already in storage.
    // See the comment there for why both are accepted for now.
    if (!request.isMultipart()) {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const { photos, ...fields } = body;

      Object.assign(formData, normalizeFormFields(fields));
      presignedPhotos = presignedPhotosSchema.parse(photos);

      for (const photo of presignedPhotos ?? []) {
        if (!photo.fieldName) continue;

        photosByField[photo.fieldName] ??= [];
        photosByField[photo.fieldName].push(photo);
      }
    }

    try {
      const parts = request.isMultipart()
        ? request.parts()
        : (async function* () {})();

      for await (const part of parts) {
        if (part.type === "file") {
          fileCount += 1;
          if (fileCount > MAX_CHECKLIST_FILES) {
            part.file.resume();
            throw new AppError(
              `O checklist permite no máximo ${MAX_CHECKLIST_FILES} fotos.`,
              400,
              "UPLOAD_FILE_LIMIT_EXCEEDED",
            );
          }

          // Group photos by field name and consume the file stream properly
          const fieldName = part.fieldname;
          if (!photosByField[fieldName]) {
            photosByField[fieldName] = [];
          }

          // We need to consume the stream to prevent hanging
          // Convert to buffer to ensure stream is consumed
          const buffer = await readMultipartFile(part, {
            maxBytes: MAX_CHECKLIST_UPLOAD_BYTES,
          });
          totalSize += buffer.length;

          if (totalSize > MAX_CHECKLIST_UPLOAD_BYTES) {
            throw new AppError(
              "O tamanho total das fotos excede o limite permitido de 5 MB.",
              400,
              "UPLOAD_SIZE_LIMIT_EXCEEDED",
            );
          }

          // Create a proper file object with consumed buffer
          const fileObject = {
            ...part,
            buffer,
            checklistFieldName: fieldName,
            toBuffer: async () => buffer,
          };

          photosByField[fieldName].push(fileObject);
        } else if (part.type === "field") {
          // Handle form fields - inline processing to avoid 'this' context issues
          const fieldName = part.fieldname;
          let value: any = part.value;

          // Handle empty notes field properly
          if (fieldName === "notes" && (!value || value === "")) {
            formData[fieldName] = null;
          } else if (value === "true") {
            // Convert string booleans to actual booleans
            formData[fieldName] = true;
          } else if (value === "false") {
            // Convert string booleans to actual booleans
            formData[fieldName] = false;
          } else if (
            fieldName === "current_mileage" &&
            typeof value === "string"
          ) {
            // Convert string numbers to actual numbers for current_mileage
            value = parseFloat(value.replace(/\./g, "").replace(",", "."));
            formData[fieldName] = value;
          } else {
            formData[fieldName] = value;
          }
        }
      }
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          code: error.code,
          message: error.message,
        });
      }

      throw error;
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

    // Extract photos to remove list for validation in usecase.
    //
    // Multipart can only carry strings, so this field arrives JSON-encoded and
    // has to be parsed. A JSON body already delivers it as an array — parsing
    // that would throw, which is why the shape is checked instead of assumed.
    const photosToRemove: string[] = Array.isArray(formData.photosToRemove)
      ? formData.photosToRemove
      : formData.photosToRemove
        ? JSON.parse(formData.photosToRemove as string)
        : [];

    const updateVehicleChecklistUseCase = container.resolve(
      UpdateVehicleChecklistUseCase,
    );

    try {
      const allPhotos: any[] = [];
      // Multipart only: on the presigned path these entries are keys, not
      // file streams, and the usecase reads them from `presignedPhotos`.
      if (!presignedPhotos)
        Object.values(photosByField).forEach((photos) => {
          allPhotos.push(...photos);
        });

      await updateVehicleChecklistUseCase.execute(
        checklistData,
        id,
        checklistId,
        businessId,
        allPhotos.length > 0 ? allPhotos : undefined,
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
