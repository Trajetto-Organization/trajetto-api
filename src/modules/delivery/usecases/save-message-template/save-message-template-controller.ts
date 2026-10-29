import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SaveMessageTemplateUseCase } from "./save-message-template-usecase";

import { saveDeliveryMessageTemplateSchema } from "@/schemas/delivery-message-template-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

class SaveMessageTemplateController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const body = saveDeliveryMessageTemplateSchema.parse(request.body);

    const useCase = container.resolve(SaveMessageTemplateUseCase);

    const saved = await useCase.execute({
      userId: id,
      businessId,
      topic: body.topic,
      channel: body.channel,
      subject: body.subject ?? null,
      body: body.body,
      is_active: body.is_active,
    });

    return reply.status(200).send({
      message: "Mensagem salva com sucesso!",
      data: { id: saved.id },
    });
  }
}

export { SaveMessageTemplateController };
