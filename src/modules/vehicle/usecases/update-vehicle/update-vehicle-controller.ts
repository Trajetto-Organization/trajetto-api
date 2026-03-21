import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateVehicleUseCase } from "./update-vehicle-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";
import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { updateVehicleSchema } from "@/schemas/update-vehicle-schema";

import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { VehicleNotFoundError } from "../errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "../errors/vehicle-not-belong-business-error";

import { VehicleTypeNotBelongBusinessError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-belong-business-error";
import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { VehicleModelYearError } from "../errors/vehicle-model-year-error";

import { VehicleAlreadyExistsError } from "../errors/vehicle-already-exists-error";
import { VehicleRenavamExistsError } from "../errors/vehicle-renavam-exists-error";

import { VehicleCurrentMileageCanNotBeUpdatedError } from "../errors/vehicle-current-mileage-can-not-be-updated";

class UpdateVehicleController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { vehicleId } = updateDeleteVehicleSchema.parse(request.params);

    const vehicleData = updateVehicleSchema.parse(request.body);
    const updateVehicleUseCase = container.resolve(UpdateVehicleUseCase);

    try {
      await updateVehicleUseCase.execute(
        vehicleData,
        vehicleId,
        businessId,
        id,
      );

      return reply
        .status(200)
        .send({ message: "Veículo atualizado com sucesso!" });
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

      if (error instanceof VehicleTypeNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FuelTypeNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof VehicleTypeNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof FuelTypeNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof BranchNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof VehicleModelYearError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleCurrentMileageCanNotBeUpdatedError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleRenavamExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateVehicleController };
