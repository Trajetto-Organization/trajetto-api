import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { ImportDeliveryXmlUseCase } from "./import-delivery-xml-usecase";

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
  }
}

export { ImportDeliveryXmlController };
