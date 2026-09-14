import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { UpdateFuelUseCase } from "./update-fuel-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { FuelNotFoundError } from "../errors/fuel-not-found-error";
import { FuelNotBelongBusinessError } from "../errors/fuel-not-belong-business-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { VehicleMileageInvalidError } from "../../../vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { FuelVehicleInvalidStatusForFuelError } from "../errors/fuel-vehicle-invalid-status-for-fuel-error";

import { FuelDriverCannotUpdateFuelError } from "../errors/fuel-driver-cannot-update-fuel-error";

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
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelTypeNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelNotBelongBusinessError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotBelongBusinessError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNotBelongBusinessError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelTypeNotBelongBusinessError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNotBelongBusinessError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleMileageInvalidError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelVehicleInvalidStatusForFuelError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelDriverCannotUpdateFuelError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateFuelController };
