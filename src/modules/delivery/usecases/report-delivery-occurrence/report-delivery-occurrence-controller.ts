import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ReportDeliveryOccurrenceUseCase } from "./report-delivery-occurrence-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
} from "../errors/delivery-errors";

import {
  OccurrenceTypeNotFoundError,
  OccurrenceTypeNotBelongBusinessError,
} from "@/modules/occurrence-type/usecases/errors/occurrence-type-errors";

import { reportDeliveryOccurrenceSchema } from "@/schemas/report-delivery-occurrence-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

class ReportDeliveryOccurrenceController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);
    const { deliveryId } = updateDeleteDeliverySchema.parse(request.params);

    const {
      occurrenceTypeId,
      description,
      latitude,
      longitude,
      photos,
      client_submission_id,
    } = reportDeliveryOccurrenceSchema.parse(request.body);

    const reportDeliveryOccurrenceUseCase = container.resolve(
      ReportDeliveryOccurrenceUseCase,
    );

    try {
      await reportDeliveryOccurrenceUseCase.execute({
        userId: id,
        businessId,
        deliveryId,
        occurrenceTypeId,
        description,
        latitude,
        longitude,
        photos,
        client_submission_id,
      });

      return reply
        .status(201)
        .send({ message: "Ocorrência registrada com sucesso!" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DeliveryNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof OccurrenceTypeNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof DeliveryNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      if (error instanceof OccurrenceTypeNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ReportDeliveryOccurrenceController };
