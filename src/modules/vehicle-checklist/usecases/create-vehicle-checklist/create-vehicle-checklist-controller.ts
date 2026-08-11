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
import { createVehicleChecklistSchema } from "@/schemas/create-vehicle-checklist-schema";

import { PhotoValidationService } from "@/shared/services/photo-validation-service";
import { AppError } from "@/shared/errors/AppError";

const MAX_CHECKLIST_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_CHECKLIST_FILES = 20;
const FILE_READ_TIMEOUT_MS = 30_000;

async function readFileWithTimeout(part: any): Promise<Buffer> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      part.toBuffer(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          part.file?.destroy(
            new Error("Tempo limite excedido durante o upload."),
          );
          reject(
            new AppError(
              "O upload demorou demais. Verifique a conexão e tente novamente.",
              408,
              "UPLOAD_TIMEOUT",
            ),
          );
        }, FILE_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class CreateVehicleChecklistController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const formData: Record<string, any> = {};
    const photosByField: Record<string, any[]> = {};
    let totalSize = 0;
    let fileCount = 0;

    // Erro de validacao encontrado no meio do multipart. NAO pode ser lancado
    // de dentro do `for await`: as partes seguintes ficariam sem ser lidas e a
    // requisicao trava sem resposta e sem log — o cliente fica girando para
    // sempre. Guardamos o erro, drenamos o restante do stream e lancamos
    // depois do laco.
    let pendingError: AppError | null = null;

    try {
      const parts = request.parts();

      for await (const part of parts) {
        // Ja falhou: so consome o que resta para liberar a requisicao.
        if (pendingError) {
          if (part.type === "file") part.file.resume();
          continue;
        }

        if (part.type === "file") {
          fileCount += 1;
          if (fileCount > MAX_CHECKLIST_FILES) {
            part.file.resume();
            pendingError = new AppError(
              `O checklist permite no máximo ${MAX_CHECKLIST_FILES} fotos.`,
              400,
              "UPLOAD_FILE_LIMIT_EXCEEDED",
            );
            continue;
          }
          // Group photos by field name and consume the file stream properly
          const fieldName = part.fieldname;
          if (!photosByField[fieldName]) {
            photosByField[fieldName] = [];
          }

          const buffer = await readFileWithTimeout(part);
          totalSize += buffer.length;

          if (totalSize > MAX_CHECKLIST_UPLOAD_BYTES) {
            pendingError = new AppError(
              "O tamanho total das fotos excede o limite permitido de 5 MB.",
              400,
              "UPLOAD_SIZE_LIMIT_EXCEEDED",
            );
            continue;
          }

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

      // Stream ja totalmente consumido: agora e seguro responder o erro.
      if (pendingError) throw pendingError;
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          code: error.code,
          message: error.message,
        });
      }

      throw error;
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
      const allPhotos: any[] = [];
      const photoFieldMapping: Record<string, string[]> = {};

      Object.entries(photosByField).forEach(([fieldName, photos]) => {
        photoFieldMapping[fieldName] = (photos as any[]).map(
          (p) => p.filename || "checklist-photo",
        );
        allPhotos.push(...photos);
      });

      const checklist = await createVehicleChecklistUseCase.execute(
        {
          ...checklistData,
          businessId,
        },
        id,
        allPhotos.length > 0 ? allPhotos : undefined,
        Object.keys(photoFieldMapping).length > 0
          ? photoFieldMapping
          : undefined,
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
