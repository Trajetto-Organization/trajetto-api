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
import { AppError } from "@/shared/errors/AppError";

import {
  normalizeFormField,
  normalizeFormFields,
} from "@/shared/utils/normalize-form-field";

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

    // Photos uploaded straight to storage, when the client took that route.
    let presignedPhotos: { key: string; fieldName?: string }[] | undefined;

    // Two request shapes are accepted while the clients migrate:
    //
    //   multipart  the original — files stream through this API
    //   JSON       the new one — files are already in the bucket, and only
    //              their keys travel here
    //
    // The JSON branch skips the streaming machinery entirely, which is the
    // whole point: no parts to drain, no buffers to hold, nothing that can
    // stall halfway through twenty photos.
    if (!request.isMultipart()) {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const { photos, ...fields } = body;

      Object.assign(formData, normalizeFormFields(fields));

      const parsedPhotos = presignedPhotosSchema.parse(photos);
      presignedPhotos = parsedPhotos;

      // Rebuilt so the existing required-photo validation keeps working
      // unchanged: it only asks whether a field has photos, not what they are.
      for (const photo of parsedPhotos ?? []) {
        if (!photo.fieldName) continue;

        photosByField[photo.fieldName] ??= [];
        photosByField[photo.fieldName].push(photo);
      }
    }

    // Erro de validacao encontrado no meio do multipart. NAO pode ser lancado
    // de dentro do `for await`: as partes seguintes ficariam sem ser lidas e a
    // requisicao trava sem resposta e sem log — o cliente fica girando para
    // sempre. Guardamos o erro, drenamos o restante do stream e lancamos
    // depois do laco.
    let pendingError: AppError | null = null;

    try {
      const parts = request.isMultipart()
        ? request.parts()
        : (async function* () {})();

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
          // Same normalisation the JSON branch runs, so a checklist validates
          // identically whichever way the client encoded it.
          formData[part.fieldname] = normalizeFormField(
            part.fieldname,
            part.value,
          );
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

      // Only meaningful for multipart: on the presigned path `photosByField`
      // holds keys, not file streams, and the usecase reads those from
      // `presignedPhotos` instead.
      if (!presignedPhotos)
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
