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

import { updateFuelMultipartSchema } from "@/schemas/update-fuel-schema";
import { updateDeleteFuelSchema } from "@/schemas/update-delete-fuel-schema";
import { readMultipartFile } from "@/shared/utils/read-multipart-file";
import { uploadConfig } from "@/config/upload";

class UpdateFuelController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId, fuelId } = updateDeleteFuelSchema.parse(request.params);

    // Use only request.parts() - the most reliable method for multipart in Fastify
    const formData: Record<string, any> = {};
    let fileUpload: any = null;

    try {
      const parts = request.parts();

      for await (const part of parts) {
        if (part.type === "field") {
          // Handle empty or "null" string for optional fields
          if (
            (part.fieldname === "notes" ||
              part.fieldname === "latitude" ||
              part.fieldname === "longitude") &&
            (!part.value || part.value === "" || part.value === null)
          ) {
            formData[part.fieldname] = null;
          } else {
            formData[part.fieldname] = part.value;
          }
        } else if (
          part.type === "file" &&
          part.fieldname === "odometer_photo"
        ) {
          // Create a proper file object that works with our existing validation
          const buffer = await readMultipartFile(part, {
            maxBytes: uploadConfig.getSizeLimit("odometerPhotos"),
          });

          fileUpload = {
            fieldname: part.fieldname,
            filename: part.filename,
            encoding: part.encoding,
            mimetype: part.mimetype,
            toBuffer: async () => buffer,
            // Add properties that Zod validation expects
            type: "file",
          };
        }
      }
    } catch (error: any) {
      throw error;
    }

    // Validate multipart data using Zod
    const { body: fuelData, file: validatedFile } =
      updateFuelMultipartSchema.parse({
        body: formData,
        file: fileUpload,
      });

    const updateFuelUseCase = container.resolve(UpdateFuelUseCase);

    try {
      await updateFuelUseCase.execute(
        {
          fuelId,
          businessId,
          fuelData,
        },
        id,
        validatedFile,
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
