import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ImportDeliveryXmlUseCase } from "./import-delivery-xml-usecase";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import {
  ShipperNotFoundError,
  ShipperNotBelongBusinessError,
} from "@/modules/shipper/usecases/errors/shipper-errors";

import { importDeliveryXmlSchema } from "@/schemas/import-delivery-xml-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class ImportDeliveryXmlController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const { files, shipperId, scheduled_date } = importDeliveryXmlSchema.parse(
      request.body,
    );

    const importDeliveryXmlUseCase = container.resolve(
      ImportDeliveryXmlUseCase,
    );

    try {
      const summary = await importDeliveryXmlUseCase.execute({
        userId: id,
        businessId,
        files,
        shipperId,
        scheduled_date,
      });

      return reply.status(200).send({
        message:
          `${summary.imported} entrega(s) importada(s), ` +
          `${summary.duplicated} duplicada(s), ${summary.invalid} com erro.`,
        data: summary,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof BusinessNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ShipperNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      if (error instanceof ShipperNotBelongBusinessError) {
        return reply.status(403).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { ImportDeliveryXmlController };
