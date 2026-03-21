import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateServiceOrderUseCase } from "./update-service-order-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import { ServiceOrderNotFoundError } from "../errors/service-order-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { SupplierNotFoundError } from "@/modules/supplier/usecases/errors/supplier-not-found-error";

import { SupplierNotBelongBusinessError } from "@/modules/supplier/usecases/errors/supplier-not-belong-business-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { ServiceOrderNotBelongBusinessError } from "../errors/service-order-not-belong-business-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { UserResponsibleNotFoundError } from "@/modules/user/usecases/errors/user-responsible-not-found-error";
import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";

import { ServiceOrderCompletionDateCannotBeEarlierOrderError } from "../errors/service-order-completion-date-cannot-be-earlier-order-date-error";
import { ServiceOrderNewMileageRequireOrderFinalizedError } from "../errors/service-order-new-mileage-require-order-finalized-error";

import { updateDeleteServiceOrderSchema } from "@/schemas/update-delete-service-order-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateServiceOrderSchema } from "@/schemas/update-service-order-schema";

class UpdateServiceOrderController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { serviceOrderId } = updateDeleteServiceOrderSchema.parse(
      request.params,
    );

    const serviceOrderData = updateServiceOrderSchema.parse(request.body);
    const updateServiceOrderUseCase = container.resolve(
      UpdateServiceOrderUseCase,
    );

    try {
      await updateServiceOrderUseCase.execute(
        serviceOrderData,
        serviceOrderId,
        businessId,
        id,
      );

      return reply
        .status(200)
        .send({ message: "Ordem de serviço atualizada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ServiceOrderNotFoundError) {
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

      if (error instanceof UserResponsibleNotFoundError) {
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

      if (error instanceof SupplierNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof BranchNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof ServiceOrderNotBelongBusinessError) {
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

export { UpdateServiceOrderController };
