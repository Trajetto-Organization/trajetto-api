import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateDeliveryUseCase } from "./update-delivery-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
  DeliveryNotEditableError,
  DeliveryVehicleUnavailableError,
} from "../errors/delivery-errors";

import {
  ShipperNotFoundError,
  ShipperNotBelongBusinessError,
} from "@/modules/shipper/usecases/errors/shipper-errors";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { updateDeliverySchema } from "@/schemas/update-delivery-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

const KNOWN_ERRORS_400 = [
  ResourceNotFoundError,
  DeliveryNotFoundError,
  DeliveryNotEditableError,
  ShipperNotFoundError,
  VehicleNotFoundError,
  DriverNotFoundError,
  DeliveryVehicleUnavailableError,
];

const KNOWN_ERRORS_403 = [
  DeliveryNotBelongBusinessError,
  ShipperNotBelongBusinessError,
  VehicleNotBelongBusinessError,
  DriverNotBelongBusinessError,
];

class UpdateDeliveryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const deliveryData = updateDeliverySchema.parse(request.body);
    const updateDeliveryUseCase = container.resolve(UpdateDeliveryUseCase);

    try {
      await updateDeliveryUseCase.execute({
        userId: id,
        businessId,
        deliveryId,
        deliveryData,
      });

      return reply
        .status(200)
        .send({ message: "Entrega atualizada com sucesso!" });
    } catch (error) {
      if (KNOWN_ERRORS_400.some((known) => error instanceof known)) {
        return reply
          .status(400)
          .send({ message: (error as Error).message });
      }

      if (KNOWN_ERRORS_403.some((known) => error instanceof known)) {
        return reply
          .status(403)
          .send({ message: (error as Error).message });
      }

      throw error;
    }
  }
}

export { UpdateDeliveryController };
