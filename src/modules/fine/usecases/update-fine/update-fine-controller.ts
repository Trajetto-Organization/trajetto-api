import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { UpdateFineUseCase } from "./update-fine-usecase";

import { updateFineSchema } from "@/schemas/update-fine-schema";
import { updateDeleteFineSchema } from "@/schemas/update-delete-fine-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BranchNotFoundError } from "@/modules/branch/usecases/errors/branch-not-found-error";

import { DriverNotFoundError } from "@/modules/driver/usecases/errors/driver-not-found-error";
import { VehicleNotFoundError } from "@/modules/vehicle/usecases/errors/vehicle-not-found-error";

import { BranchNotBelongBusinessError } from "@/modules/branch/usecases/errors/branch-not-belong-business-error";
import { DriverNotBelongBusinessError } from "@/modules/driver/usecases/errors/driver-not-belong-business-error";

import { VehicleNotBelongBusinessError } from "@/modules/vehicle/usecases/errors/vehicle-not-belong-business-error";
import { TrafficViolationCodeNotFoundError } from "../errors/traffic-violation-code-not-found-error";

import { FineNotFoundError } from "../errors/fine-not-found-error";
import { FineNumberAlreadyExistsError } from "../errors/fine-number-already-exists-error";

import { FineDueDateMustBeAfterInfractionError } from "../errors/fine-due-date-must-be-after-infraction-error";
import { FinePaymentDateCannotBeEarlierInfractionError } from "../errors/fine-payment-date-cannot-be-earlier-infraction-error";

import { FineUserNotAllowedChangeError } from "../errors/fine-user-not-allowed-change-error";
import { FineDueDateInfractionCannotBeLaterError } from "../errors/fine-due-date-infraction-cannot-be-later-error";

import { FineDueDateMustBeLaterInfractionError } from "../errors/fine-due-date-must-be-later-infraction-error";

class UpdateFineController {
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Response> {
    const { id } = request.user;

    const { fineId } = updateDeleteFineSchema.parse(request.params);
    const fineData = updateFineSchema.parse(request.body);

    const updateFineUseCase = container.resolve(UpdateFineUseCase);

    try {
      await updateFineUseCase.execute(fineData, fineId, id);

      return reply.status(200).send({
        message: "Multa atualizada com sucesso!",
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
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

      if (error instanceof FineDueDateMustBeAfterInfractionError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FinePaymentDateCannotBeEarlierInfractionError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FineDueDateInfractionCannotBeLaterError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FineDueDateMustBeLaterInfractionError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof FineUserNotAllowedChangeError) {
        return reply.status(403).send({ message: error.message });
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

      if (error instanceof FineNotFoundError) {
        return reply.status(404).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { UpdateFineController };
