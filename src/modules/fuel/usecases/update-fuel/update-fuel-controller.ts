import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { UpdateFuelUseCase } from "./update-fuel-usecase";

import { replyFuelWriteError } from "../errors/fuel-http-errors";

import { updateFuelSchema } from "@/schemas/update-fuel-schema";
import { presignedPhotoSchema } from "@/schemas/presigned-photos-schema";

import { normalizeFormFields } from "@/shared/utils/normalize-form-field";
import { updateDeleteFuelSchema } from "@/schemas/update-delete-fuel-schema";

class UpdateFuelController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId, fuelId } = updateDeleteFuelSchema.parse(request.params);

    // The replacement photo, if any, is already in storage and only its key
    // travels here.
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { photo, ...fields } = body;

    const formData: Record<string, any> = normalizeFormFields(fields);

    // Optional on update — an edit that does not touch the photo simply omits
    // it, and the record keeps the one it already has.
    const presignedPhoto =
      photo !== undefined
        ? { key: presignedPhotoSchema.parse(photo).key }
        : undefined;

    const fuelData = updateFuelSchema.parse(formData);
    const updateFuelUseCase = container.resolve(UpdateFuelUseCase);

    try {
      await updateFuelUseCase.execute(
        {
          fuelId,
          businessId,
          fuelData,
        },
        id,
        presignedPhoto,
      );

      return reply
        .status(200)
        .send({ message: "Abastecimento atualizado com sucesso!" });
    } catch (error) {
      // The refueling in the path missing (or another company's) is 404
      // FUEL_NOT_FOUND; a link in the body that does not resolve is 400 with
      // its code, a foreign id answered like a missing one (fuel-http-errors).
      if (replyFuelWriteError(reply, error)) return;

      throw error;
    }
  }
}

export { UpdateFuelController };
