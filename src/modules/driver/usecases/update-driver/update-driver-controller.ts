import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateDriverUseCase } from "./update-driver-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { DriverNotFoundError } from "../errors/driver-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { updateDriverSchema } from "@/schemas/update-driver-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { DriverCpfAlreadyExistsError } from "../errors/driver-cpf-already-exists-error";
import { DriverRgAlreadyExistsError } from "../errors/driver-rg-already-exists-error";

import { DriverLicenseAlreadyExistsError } from "../errors/driver-license-already-exists-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { updateDeleteDriverSchema } from "@/schemas/update-delete-driver-schema";

class UpdateDriverController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { driverId } = updateDeleteDriverSchema.parse(request.params);

    const driverData = updateDriverSchema.parse(request.body);
    const updateDriverUseCase = container.resolve(UpdateDriverUseCase);

    try {
      await updateDriverUseCase.execute(
        {
          ...driverData,
          businessId,
        },
        driverId,
        id,
        businessId,
      );

      return reply
        .status(200)
        .send({ message: "Motorista atualizado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverCpfAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverRgAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DriverLicenseAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateDriverController };
