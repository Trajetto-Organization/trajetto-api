import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { AssignDeliveriesUseCase } from "./assign-deliveries-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
  DeliveryNotAssignableError,
  DeliveryDriverInactiveError,
  DeliveryVehicleUnavailableError,
} from "../errors/delivery-errors";

import { assignDeliveriesSchema } from "@/schemas/assign-deliveries-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class AssignDeliveriesController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const { deliveryIds, driverId, vehicleId } = assignDeliveriesSchema.parse(
      request.body,
    );

    const assignDeliveriesUseCase = container.resolve(AssignDeliveriesUseCase);

    try {
      const { assigned, routeId, routeCode } =
        await assignDeliveriesUseCase.execute({
          userId: id,
          businessId,
          deliveryIds,
          driverId,
          vehicleId,
        });

      // The route id travels back so the client can offer to open what it
      // just created — the assignment is no longer a column change with
      // nothing to look at.
      return reply.status(200).send({
        message: `Rota ${routeCode} criada e liberada com ${assigned} entrega${assigned > 1 ? "s" : ""}.`,
        data: { assigned, routeId, routeCode },
      });
    } catch (error) {
      if (
        error instanceof ResourceNotFoundError ||
        error instanceof DriverNotFoundError ||
        error instanceof VehicleNotFoundError ||
        error instanceof DeliveryNotFoundError ||
        error instanceof DeliveryNotAssignableError ||
        error instanceof DeliveryDriverInactiveError ||
        error instanceof DeliveryVehicleUnavailableError
      ) {
        return reply.status(400).send({ message: error.message });
      }

      if (
        error instanceof DriverNotBelongBusinessError ||
        error instanceof VehicleNotBelongBusinessError ||
        error instanceof DeliveryNotBelongBusinessError
      ) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { AssignDeliveriesController };
