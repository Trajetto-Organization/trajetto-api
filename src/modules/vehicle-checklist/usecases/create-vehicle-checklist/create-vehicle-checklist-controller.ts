import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { CreateVehicleChecklistUseCase } from "./create-vehicle-checklist-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { VehicleMileageInvalidError } from "@/modules/fuel/usecases/errors/vehicle-mileage-invalid-error";

import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { createVehicleChecklistSchema } from "@/schemas/create-vehicle-checklist-schema";

import { PhotoValidationService } from "../../services/photo-validation-service";

class CreateVehicleChecklistController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const formData: Record<string, any> = {};
    const photosByField: Record<string, any[]> = {};

    try {
      const parts = request.parts();

      // Add timeout to prevent infinite loops
      const processingTimeout = setTimeout(() => {
        console.error(
          "[CreateVehicleChecklistController] TIMEOUT: Parts processing took too long!",
        );
      }, 30000); // 30 seconds timeout

      let partCount = 0;
      for await (const part of parts) {
        partCount++;

        if (part.type === "file") {
          // Group photos by field name and consume the file stream properly
          const fieldName = part.fieldname;
          if (!photosByField[fieldName]) {
            photosByField[fieldName] = [];
          }

          // We need to consume the stream to prevent hanging
          // Convert to buffer to ensure stream is consumed
          try {
            console.log(
              `[CreateVehicleChecklistController] Reading file buffer for: ${fieldName}`,
            );
            const buffer = await part.toBuffer();

            // Create a proper file object with consumed buffer
            const fileObject = {
              ...part,
              buffer: buffer,
              toBuffer: async () => buffer,
            };

            photosByField[fieldName].push(fileObject);
          } catch (fileError) {
            throw fileError;
          }
        } else if (part.type === "field") {
          // Handle form fields - inline processing to avoid 'this' context issues
          const fieldName = part.fieldname;
          let value: any = part.value;

          // Convert string booleans to actual booleans
          if (value === "true") {
            value = true;
          } else if (value === "false") {
            value = false;
          } else if (
            fieldName === "current_mileage" &&
            typeof value === "string"
          ) {
            // Convert string numbers to actual numbers for current_mileage
            value = parseFloat(value.replace(/\./g, "").replace(",", "."));
          }

          formData[fieldName] = value;
        }
      }

      clearTimeout(processingTimeout);
    } catch (error) {
      return reply.status(400).send({
        message:
          "Erro ao processar dados do formulário. Verifique se todos os campos estão preenchidos corretamente.",
      });
    }

    // Validate total file size for all uploaded photos
    let totalSize = 0;
    const maxTotalSize = 5 * 1024 * 1024; // 5MB total for all files

    for (const [fieldName, files] of Object.entries(photosByField)) {
      for (const file of files as any[]) {
        if (file.buffer) {
          totalSize += file.buffer.length;
        }
      }
    }

    if (totalSize > maxTotalSize) {
      return reply.status(400).send({
        message: `O tamanho total dos arquivos excede o limite permitido de 5MB. Tamanho atual: ${(totalSize / 1024 / 1024).toFixed(2)}MB`,
      });
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
      const allPhotos: any[] = [];
      Object.values(photosByField).forEach((photos) => {
        allPhotos.push(...photos);
      });

      await createVehicleChecklistUseCase.execute(
        {
          ...checklistData,
          businessId,
        },
        id,
        allPhotos.length > 0 ? allPhotos : undefined,
      );

      return reply
        .status(201)
        .send({ message: "Checklist veicular criado com sucesso!" });
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
