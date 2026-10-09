import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { CreateVehicleChecklistUseCase } from "./create-vehicle-checklist-usecase";

import { replyChecklistError } from "../errors/vehicle-checklist-http-errors";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { presignedPhotosSchema } from "@/schemas/presigned-photos-schema";

import { createVehicleChecklistSchema } from "@/schemas/create-vehicle-checklist-schema";

import { PhotoValidationService } from "@/shared/services/photo-validation-service";
import { normalizeFormFields } from "@/shared/utils/normalize-form-field";
import { submissionKeyOf } from "@/shared/http/submission-key";

class CreateVehicleChecklistController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const createVehicleChecklistUseCase = container.resolve(
      CreateVehicleChecklistUseCase,
    );

    // A resend of a checklist that already exists is answered with it before
    // the body is validated: the outbox froze that body on an older version
    // of the app, and a schema tightened since must not turn a recorded
    // inspection into a failed one (see `submissionKeyOf`). The route's
    // guards — tenant, branch, permission, module — have all run by now.
    const replayKey = submissionKeyOf(
      request.body,
      request.headers["idempotency-key"],
    );

    if (replayKey) {
      const replay = await createVehicleChecklistUseCase.findReplay(
        businessId,
        replayKey,
        request.user.driverId,
      );

      if (replay) {
        return reply.header("Idempotency-Key", replayKey).status(201).send({
          message: "Checklist veicular criado com sucesso!",
          id: replay.id,
        });
      }
    }

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
      // Codes in `x-error-code` as well: the route's response schema strips
      // unknown body fields, and the app's queue decides from the code whether
      // a refusal is on the merits or a contract its build no longer meets.
      return reply.header("x-error-code", "VALIDATION_ERROR").status(400).send({
        code: "VALIDATION_ERROR",
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
      return reply.header("x-error-code", "PHOTOS_REQUIRED").status(400).send({
        code: "PHOTOS_REQUIRED",
        message: "Fotos obrigatórias não fornecidas",
        errors: photoValidation.errors,
        missingPhotos: photoValidation.missingPhotos,
        photoRequirements:
          PhotoValidationService.validatePhotosRequired(checklistData),
      });
    }

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
      // Foreign ids answer like unknown ones; every refusal carries a code
      // (vehicle-checklist-http-errors).
      if (replyChecklistError(reply, error)) return;

      throw error;
    }
  }
}

export { CreateVehicleChecklistController };
