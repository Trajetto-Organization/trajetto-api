import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateDeliveryUseCase } from "./create-delivery-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import {
  ShipperNotFoundError,
  ShipperNotBelongBusinessError,
} from "@/modules/shipper/usecases/errors/shipper-errors";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import {
  DeliveryInvoiceKeyExistsError,
  DeliveryVehicleUnavailableError,
} from "../errors/delivery-errors";
import { createDeliverySchema } from "@/schemas/create-delivery-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

const KNOWN_ERRORS_400 = [
  ResourceNotFoundError,
  BusinessNotFoundError,
  ShipperNotFoundError,
  VehicleNotFoundError,
  DriverNotFoundError,
  DeliveryInvoiceKeyExistsError,
  DeliveryVehicleUnavailableError,
];

const KNOWN_ERRORS_403 = [
  ShipperNotBelongBusinessError,
  VehicleNotBelongBusinessError,
  DriverNotBelongBusinessError,
];

class CreateDeliveryController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const deliveryData = createDeliverySchema.parse(request.body);
    const createDeliveryUseCase = container.resolve(CreateDeliveryUseCase);

    try {
      const delivery = await createDeliveryUseCase.execute(
        { ...deliveryData, businessId },
        id,
      );

      return reply.status(201).send({
        message: "Entrega criada com sucesso!",
        data: { id: delivery.id },
      });
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

export { CreateDeliveryController };
