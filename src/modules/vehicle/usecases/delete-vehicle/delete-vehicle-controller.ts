import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { DeleteVehicleUseCase } from "./delete-vehicle-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { updateDeleteVehicleSchema } from "@/schemas/update-delete-vehicle-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { VehicleNotFoundError } from "../errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "../errors/vehicle-not-belong-business-error";

import { VehicleHasAssociatedFinesError } from "../errors/vehicle-has-associated-fines-error";
import { VehicleHasAssociatedServiceOrdersError } from "../errors/vehicle-has-associated-service-orders-error";

import { VehicleHasAssociatedFuelError } from "../errors/vehicle-has-associated-fuel-error";

class DeleteVehicleController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { vehicleId } = updateDeleteVehicleSchema.parse(request.params);

    const deleteVehicleUseCase = container.resolve(DeleteVehicleUseCase);

    try {
      await deleteVehicleUseCase.execute(vehicleId, businessId, id);

      return reply
        .status(200)
        .send({ message: "Veículo deletado com sucesso!" });
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

      if (error instanceof VehicleNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof VehicleHasAssociatedFinesError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof VehicleHasAssociatedServiceOrdersError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof VehicleHasAssociatedFuelError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteVehicleController };
