import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";

import { DeleteVehicleChecklistUseCase } from "./delete-vehicle-checklist-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleChecklistNotFoundError } from "../errors/vehicle-checklist-not-found-error";
import { VehicleChecklistNotBelongBusinessError } from "../errors/vehicle-checklist-not-belong-business-error";

import { DriverCannotDeleteChecklistError } from "../errors/driver-cannot-delete-checklist-error";
import { updateDeleteVehicleChecklistSchema } from "@/schemas/update-delete-vehicle-checklist-schema";

class DeleteVehicleChecklistController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id: userId } = request.user;

    const { businessId, checklistId } =
      updateDeleteVehicleChecklistSchema.parse(request.params);

    const deleteVehicleChecklistUseCase = container.resolve(
      DeleteVehicleChecklistUseCase,
    );

    try {
      await deleteVehicleChecklistUseCase.execute({
        checklistId,
        businessId,
        userId,
      });

      return reply.status(200).send({
        message: "Checklist veicular excluído com sucesso!",
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleChecklistNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      if (error instanceof VehicleChecklistNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof DriverCannotDeleteChecklistError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { DeleteVehicleChecklistController };
