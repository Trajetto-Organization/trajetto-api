import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { CreateFuelUseCase } from "./create-fuel-usecase";

import { replyFuelWriteError } from "../errors/fuel-http-errors";

import { createFuelSchema } from "@/schemas/create-fuel-schema";

import { presignedPhotoSchema } from "@/schemas/presigned-photos-schema";
import { normalizeFormFields } from "@/shared/utils/normalize-form-field";
import { submissionKeyOf } from "@/shared/http/submission-key";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateFuelController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const createFuelUseCase = container.resolve(CreateFuelUseCase);

    // A resend of a fueling that already exists is answered with it before
    // the body is validated: the outbox froze that body on an older version
    // of the app, and a schema tightened since must not turn a recorded
    // fueling into a failed one (see `submissionKeyOf`). The route's guards
    // — tenant, branch, permission, module — have all run by now.
    const replayKey = submissionKeyOf(
      request.body,
      request.headers["idempotency-key"],
    );

    if (replayKey) {
      const replay = await createFuelUseCase.findReplay(
        businessId,
        replayKey,
        request.user.driverId,
      );

      if (replay) {
        return reply.header("Idempotency-Key", replayKey).status(201).send({
          message: "Abastecimento criado com sucesso!",
          id: replay.id,
        });
      }
    }

    // The photo is already in storage and only its key travels here.
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { photo, ...fields } = body;

    const formData: Record<string, any> = normalizeFormFields(fields);
    const parsed = presignedPhotoSchema.safeParse(photo);

    // Codes in `x-error-code` as well: the route's response schema strips
    // unknown body fields, and the app's queue decides from the code whether
    // a refusal is on the merits or a contract its build no longer meets.
    if (!parsed.success) {
      return reply.header("x-error-code", "PHOTO_REQUIRED").status(400).send({
        code: "PHOTO_REQUIRED",
        message: "Foto do odômetro é obrigatória.",
      });
    }

    const presignedPhoto = { key: parsed.data.key };

    const idempotencyKey = request.headers["idempotency-key"];
    if (!formData.client_submission_id && typeof idempotencyKey === "string") {
      formData.client_submission_id = idempotencyKey;
    }

    const fuelData = createFuelSchema.parse(formData);

    try {
      const fuel = await createFuelUseCase.execute(
        {
          ...fuelData,
          businessId,
        },
        id,
        presignedPhoto,
      );

      return reply
        .header(
          "Idempotency-Key",
          fuelData.client_submission_id ?? "not-provided",
        )
        .status(201)
        .send({ message: "Abastecimento criado com sucesso!", id: fuel.id });
    } catch (error) {
      // One table for every fuel write (fuel-http-errors.ts): a code on each
      // refusal, and another company's vehicle, driver, fuel type or branch
      // answered exactly like a missing one.
      if (replyFuelWriteError(reply, error)) return;

      throw error;
    }
  }
}

export { CreateFuelController };
