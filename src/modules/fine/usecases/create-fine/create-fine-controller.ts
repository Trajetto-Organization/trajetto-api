import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { CreateFineUseCase } from "./create-fine-usecase";
import { createFineSchema } from "@/schemas/create-fine-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/user/usecases/errors/business-not-found-error";

import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";
import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";

import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";
import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";

import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";
import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";

import { TrafficViolationCodeNotFoundError } from "../errors/traffic-violation-code-not-found-error";
import { FineNumberAlreadyExistsError } from "../errors/fine-number-already-exists-error";

import { FineDateInfractionCannotBeFutureError } from "../errors/fine-date-infraction-cannot-be-future-error";
import { FineDueDateMustBeAfterInfractionError } from "../errors/fine-due-date-must-be-after-infraction-error";

import { FinePaymentDateCannotBeEarlierInfractionError } from "../errors/fine-payment-date-cannot-be-earlier-infraction-error";
import { FineRegistrationsMobileLocationRequiredError } from "../errors/fine-registrations-mobile-location-required-error";

import { FineLocationNotProvidedAdjustmentValidationError } from "../errors/fine-location-not-provided-adjustment-validation-error";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class CreateFineController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const fineData = createFineSchema.parse(request.body);

    const createFineUseCase = container.resolve(CreateFineUseCase);

    try {
      await createFineUseCase.execute(
        {
          ...fineData,
          businessId,
        },
        id,
      );

      return reply.status(201).send({
        message: "Multa registrada com sucesso!",
      });
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

      if (error instanceof DriverNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof VehicleNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof TrafficViolationCodeNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FineNumberAlreadyExistsError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FineDateInfractionCannotBeFutureError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FineDueDateMustBeAfterInfractionError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FinePaymentDateCannotBeEarlierInfractionError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FineRegistrationsMobileLocationRequiredError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FineLocationNotProvidedAdjustmentValidationError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BranchNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof DriverNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof VehicleNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { CreateFineController };
