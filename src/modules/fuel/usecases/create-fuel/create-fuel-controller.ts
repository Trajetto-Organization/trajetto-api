import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { CreateFuelUseCase } from "./create-fuel-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { VehicleMileageInvalidError } from "../../../vehicle/usecases/errors/vehicle-mileage-invalid-error";
import { FuelVehicleInvalidStatusForFuelError } from "../errors/fuel-vehicle-invalid-status-for-fuel-error";

import { FuelLocationNotProvidedAdjustmentValidationError } from "../errors/fuel-location-not-provided-adjustment-validation-error";
import { VehicleNotAssignedToDriverError } from "@/modules/vehicle/usecases/errors/vehicle-not-assigned-to-driver-error";

import { FuelRegistrationsMobileLocationRequiredError } from "../errors/fuel-registrations-mobile-location-required-error";

import { MultipartFile } from "@fastify/multipart";
import {
  createFuelMultipartSchema,
  createFuelSchema,
} from "@/schemas/create-fuel-schema";

import { presignedPhotoSchema } from "@/schemas/presigned-photos-schema";
import { normalizeFormFields } from "@/shared/utils/normalize-form-field";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateFuelController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const isMultipart = request.isMultipart();
    const formData: Record<string, any> = {};

    let validatedFile: MultipartFile | undefined;
    let presignedPhoto: { key: string } | undefined;

    if (isMultipart) {
      const file = await request.file();

      if (!file) {
        return reply.status(400).send({
          message: "Arquivo de odômetro é obrigatório.",
        });
      }

      // Extract form fields from multipart data
      if (file.fields) {
        Object.keys(file.fields).forEach((key) => {
          const field = file.fields[key];
          if (field && typeof field === "object" && "value" in field) {
            formData[key] = field.value;
          }
        });
      }

      validatedFile = createFuelMultipartSchema.parse({
        body: formData,
        file,
      }).file;
    } else {
      // JSON body: the photo is already in storage and only its key travels
      // here. `request.file()` is never called — there is no multipart stream
      // to read, and asking for one would hang the request.
      const body = (request.body ?? {}) as Record<string, unknown>;
      const { photo, ...fields } = body;

      Object.assign(formData, normalizeFormFields(fields));

      const parsed = presignedPhotoSchema.safeParse(photo);

      if (!parsed.success) {
        return reply.status(400).send({
          message: "Foto do odômetro é obrigatória.",
        });
      }

      presignedPhoto = { key: parsed.data.key };
    }

    const idempotencyKey = request.headers["idempotency-key"];
    if (!formData.client_submission_id && typeof idempotencyKey === "string") {
      formData.client_submission_id = idempotencyKey;
    }

    // The body half of the schema is shared by both shapes — only the file
    // half differs, and that was handled above.
    const fuelData = createFuelSchema.parse(formData);
    const createFuelUseCase = container.resolve(CreateFuelUseCase);

    try {
      const fuel = await createFuelUseCase.execute(
        {
          ...fuelData,
          businessId,
        },
        id,
        validatedFile,
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

      if (error instanceof FuelTypeNotFoundError) {
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

      if (error instanceof VehicleNotAssignedToDriverError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelLocationNotProvidedAdjustmentValidationError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelRegistrationsMobileLocationRequiredError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateFuelController };
