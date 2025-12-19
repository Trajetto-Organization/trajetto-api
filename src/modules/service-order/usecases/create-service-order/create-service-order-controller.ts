import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateServiceOrderUseCase } from "./create-service-order-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";
import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";

import { ServiceOrderNewMileageRequireOrderFinalizedError } from "../errors/service-order-new-mileage-require-order-finalized-error";
import { ServiceOrderCompletionDateCannotBeEarlierOrderError } from "../errors/service-order-completion-date-cannot-be-earlier-order-date-error";

import { ServiceOrderLocationNotProvidedAdjustmentValidationError } from "../errors/service-order-location-not-provided-adjustment-validation-error";
import { ServiceOrderRegistrationsMobileLocationRequiredError } from "../errors/service-order-registrations-mobile-location-required-error";

import { UserResponsibleNotFoundError } from "@/modules/user/usecases/errors/user-responsible-not-found-error";

import { createServiceOrderSchema } from "@/schemas/create-service-order-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateServiceOrderController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const serviceOrderData = createServiceOrderSchema.parse(request.body);
    const createServiceOrderUseCase = container.resolve(
      CreateServiceOrderUseCase,
    );

    try {
      await createServiceOrderUseCase.execute(
        {
          ...serviceOrderData,
          businessId,
        },
        id,
      );

      return reply
        .status(201)
        .send({ message: "Ordem de serviço criada com sucesso!" });
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

      if (error instanceof BranchNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof SupplierNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (
        error instanceof ServiceOrderCompletionDateCannotBeEarlierOrderError
      ) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ServiceOrderNewMileageRequireOrderFinalizedError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof UserResponsibleNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (
        error instanceof ServiceOrderRegistrationsMobileLocationRequiredError
      ) {
        return reply.status(400).send({ message: error.message });
      }

      if (
        error instanceof
        ServiceOrderLocationNotProvidedAdjustmentValidationError
      ) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof SupplierNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof BranchNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof VehicleNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof UserNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateServiceOrderController };
