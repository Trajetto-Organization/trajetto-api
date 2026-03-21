import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateDriverUseCase } from "./create-driver-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { DriverCpfAlreadyExistsError } from "../errors/driver-cpf-already-exists-error";

import { DriverLicenseAlreadyExistsError } from "../errors/driver-license-already-exists-error";
import { DriverRgAlreadyExistsError } from "../errors/driver-rg-already-exists-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { createDriverSchema } from "@/schemas/create-driver-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateDriverController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const driverData = createDriverSchema.parse(request.body);
    const createDriverUseCase = container.resolve(CreateDriverUseCase);

    try {
      await createDriverUseCase.execute(
        {
          ...driverData,
          businessId,
        },
        id,
      );

      return reply
        .status(201)
        .send({ message: "Motorista criado com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
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

export { CreateDriverController };
