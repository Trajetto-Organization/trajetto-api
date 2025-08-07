import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateVehicleUseCase } from "./create-vehicle-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleAlreadyExistsError } from "../errors/vehicle-already-exists-error";
import { VehicleRenavamExistsError } from "../errors/vehicle-renavam-exists-error";

import { VehicleTypeNotBelongBusinessError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-belong-business-error";
import { VehicleModelYearError } from "../errors/vehicle-model-year-error";

import { VehicleTypeNotFoundError } from "@/modules/vehicle-type/usecases/errors/vehicle-type-not-found-error";
import { FuelTypeNotFoundError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { createVehicleSchema } from "@/schemas/create-vehicle-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { FuelTypeNotBelongBusinessError } from "@/modules/fuel-type/usecases/errors/fuel-type-not-belong-business-error";

class CreateVehicleController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const vehicleData = createVehicleSchema.parse(request.body);
    const createVehicleUseCase = container.resolve(CreateVehicleUseCase);

    try {
      await createVehicleUseCase.execute(
        {
          ...vehicleData,
          businessId,
        },
        id,
      );

      return reply.status(201).send({ message: "Veículo criado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleTypeNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof VehicleRenavamExistsError) {
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

      if (error instanceof VehicleModelYearError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof BranchNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof FuelTypeNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateVehicleController };
