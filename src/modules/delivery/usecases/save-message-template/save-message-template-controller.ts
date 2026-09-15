import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { SaveMessageTemplateUseCase } from "./save-message-template-usecase";

import { saveDeliveryMessageTemplateSchema } from "@/schemas/delivery-message-template-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

class SaveMessageTemplateController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = request.user;
    const { businessId } = updateDeleteBusinessSchema.parse(request.params);

    const body = saveDeliveryMessageTemplateSchema.parse(request.body);

    const useCase = container.resolve(SaveMessageTemplateUseCase);

    try {
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
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return reply.status(400).send({ message: error.message });
      }

      throw error;
    }
  }
}

export { SaveMessageTemplateController };
